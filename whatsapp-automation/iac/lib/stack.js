'use strict';
/*
 * WaAutomationStack — all infrastructure for the whatsapp-automation service.
 * Safe by default: DRY_RUN=true on every Lambda, flows OFF (flags live in the
 * runtime config item / env), data resources RETAINed. Nothing here sends a
 * message or moves money; that is gated by config the operator flips later.
 */
const path = require('path');
const fs = require('fs');
const cdk = require('aws-cdk-lib');
const { Duration, RemovalPolicy } = cdk;
const dynamodb = require('aws-cdk-lib/aws-dynamodb');
const sqs = require('aws-cdk-lib/aws-sqs');
const s3 = require('aws-cdk-lib/aws-s3');
const lambda = require('aws-cdk-lib/aws-lambda');
const { SqsEventSource } = require('aws-cdk-lib/aws-lambda-event-sources');
const secretsmanager = require('aws-cdk-lib/aws-secretsmanager');
const iam = require('aws-cdk-lib/aws-iam');
const events = require('aws-cdk-lib/aws-events');
const targets = require('aws-cdk-lib/aws-events-targets');
const sns = require('aws-cdk-lib/aws-sns');
const subs = require('aws-cdk-lib/aws-sns-subscriptions');
const cw = require('aws-cdk-lib/aws-cloudwatch');
const logs = require('aws-cdk-lib/aws-logs');
const logDests = require('aws-cdk-lib/aws-logs-destinations');
const cwActions = require('aws-cdk-lib/aws-cloudwatch-actions');
const { HttpApi, HttpMethod } = require('aws-cdk-lib/aws-apigatewayv2');
const { HttpLambdaIntegration } = require('aws-cdk-lib/aws-apigatewayv2-integrations');

// Code asset = the service root, minus what the Lambda does not need.
const CODE = lambda.Code.fromAsset(path.join(__dirname, '..', '..'), {
  exclude: ['iac', 'node_modules', '.git', 'cdk.out', 'data', '.env', '.env.*', '**/*.test.mjs', '**/*.md'],
});

/*
 * The ONE npm dependency that reaches a Lambda, and it does so through a layer.
 *
 * CODE above excludes node_modules, so for most of this service's life nothing
 * from npm ran in production at all. The P&L report needs exceljs to write an
 * .xlsx, and widening that exclude would push vitest, typescript and the whole
 * AWS SDK into all sixteen functions.
 *
 * Built by `npm run pnl:layer`, which is NOT part of cdk. So synth refuses when
 * the directory is missing rather than deploying a function whose very first
 * import throws at runtime, where the only symptom would be a report that never
 * arrives.
 */
const PNL_LAYER_DIR = path.join(__dirname, '..', 'layers', 'pnl');

class WaAutomationStack extends cdk.Stack {
  constructor(scope, id, props = {}) {
    super(scope, id, props);

    // ---- S3: reports, snapshots and the ledger the owner uploads ---------
    /*
     * RETAIN and versioned, for the same reason the table is: a month's
     * workbook is a financial record the owner may hand to an accountant, and
     * a re-run of a month must not destroy what the previous run said. The
     * snapshot beside it is what lets next month restate this one.
     *
     * Private with no exception. Nothing public ever needs to read it, which is
     * also why the WhatsApp delivery path uploads the file to Meta rather than
     * sending a link.
     */
    const reports = new s3.Bucket(this, 'Reports', {
      encryption: s3.BucketEncryption.S3_MANAGED,
      blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
      enforceSSL: true,
      versioned: true,
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---- DynamoDB single table -------------------------------------------
    const table = new dynamodb.Table(this, 'Table', {
      tableName: 'wa-automation',
      partitionKey: { name: 'PK', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'SK', type: dynamodb.AttributeType.STRING },
      billingMode: dynamodb.BillingMode.PAY_PER_REQUEST,
      pointInTimeRecoverySpecification: { pointInTimeRecoveryEnabled: true },
      timeToLiveAttribute: 'expiresAt',
      removalPolicy: RemovalPolicy.RETAIN,
    });
    table.addGlobalSecondaryIndex({
      indexName: 'GSI1',
      partitionKey: { name: 'activeShipment', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    /*
     * GSI2: the rows a sweep needs, keyed by WHAT they are and WHEN.
     *
     * A DynamoDB Scan reads up to 1 MB a page and is billed for everything it
     * reads, not for what the filter returns. Six callers were doing exactly
     * that, and one of them runs every five minutes inside 09:30 to 22:30:
     * measured over the 30 days to 2026-11-06 the table served 229,616 read
     * units against 12,370 write units, 18.6 reads per write, on 4,017 items.
     * The ratio gets worse as the table grows, which is the part that matters.
     *
     * SPARSE on purpose. Only rows that carry `kind` appear here, so the index
     * holds captures, cart records, subscriber records and replacement rows,
     * and not the STATE, MSG#, WAMID#, dedupe or rate-limit rows that are most
     * of the table. A sweep then reads the rows it needs and nothing else.
     *
     * Projection ALL because every reader wants the whole row: a KEYS_ONLY
     * index would turn one query into a query plus N gets, which is the cost
     * this is removing.
     */
    table.addGlobalSecondaryIndex({
      indexName: 'GSI2',
      partitionKey: { name: 'kind', type: dynamodb.AttributeType.STRING },
      sortKey: { name: 'kindAt', type: dynamodb.AttributeType.STRING },
      projectionType: dynamodb.ProjectionType.ALL,
    });

    // ---- SQS FIFO + DLQ ---------------------------------------------------
    const dlq = new sqs.Queue(this, 'Dlq', {
      queueName: 'wa-automation-dlq.fifo',
      fifo: true,
      contentBasedDeduplication: false,
      retentionPeriod: Duration.days(14),
    });
    const queue = new sqs.Queue(this, 'Queue', {
      queueName: 'wa-automation.fifo',
      fifo: true,
      // MUST stay true. EventBridge Scheduler's SQS target can only supply a
      // MessageGroupId, never a MessageDeduplicationId, so with this off every
      // timer delivery fails with InvalidParameterValue, the schedule then
      // self-deletes (ActionAfterCompletion: DELETE) and the timer disappears
      // silently. That kills every timed step in all four flows. The ingest
      // path is unaffected: it passes an explicit MessageDeduplicationId,
      // which always takes precedence over content-based dedup.
      contentBasedDeduplication: true,
      visibilityTimeout: Duration.seconds(360), // >= 6x worker timeout
      deadLetterQueue: { queue: dlq, maxReceiveCount: 5 },
    });

    // ---- Secrets (one JSON; filled in by hand, see README) ---------------
    const secret = new secretsmanager.Secret(this, 'Secrets', {
      secretName: 'wa-automation/secrets',
      description: 'WhatsApp/Shopify/Razorpay/Delhivery tokens + signing keys. Fill via console/CLI.',
      removalPolicy: RemovalPolicy.RETAIN,
    });

    // ---- Scheduler execution role (one-time timers -> the FIFO queue) -----
    const schedulerRole = new iam.Role(this, 'SchedulerRole', {
      assumedBy: new iam.ServicePrincipal('scheduler.amazonaws.com'),
      description: 'Assumed by EventBridge Scheduler one-time timers to enqueue onto the FIFO queue.',
    });
    queue.grantSendMessages(schedulerRole);

    // ---- Lambda factory ---------------------------------------------------
    const commonEnv = {
      // Go-live switches. Defaults stay safe (dry run, every flow off) so an
      // unparameterised deploy can never start messaging customers. Set them
      // in cdk.json context; see README "Go live".
      DRY_RUN: props.dryRun === false ? 'false' : 'true',
      SEND_ALLOWLIST: props.sendAllowlist || '',
      ORDER_ALLOWLIST: props.orderAllowlist || '',
      OWNER_ALERT_PHONES: props.ownerAlertPhones || '',
      // Gates the live COD->prepaid order edit. Only 'true' once the
      // sequence has been verified against a real order (DECISIONS C3).
      CONVERSION_VERIFIED: props.conversionVerified === true ? 'true' : 'false',
      // How Flow B asks for the review: 'flow' (native WhatsApp Flow) or
      // 'link' (Google Form button). Carried here and not only flipped on the
      // Lambda, because a later deploy would otherwise quietly put it back to
      // 'flow', whose template Meta has not approved, and the review ask would
      // stop with nothing reporting that it had.
      REVIEW_VIA: props.reviewVia === 'link' ? 'link' : 'flow',
      VARIANT_CHANGE_ENABLED: String(Boolean(props.variantChangeEnabled)),
      /*
       * /replace (replacement shipments). SHADOW unless the context says
       * otherwise, and shadow is the mode where everything runs except the two
       * courier writes and the customer message. Carried here rather than only
       * flipped on the Lambda for the same reason as REVIEW_VIA: a later deploy
       * would otherwise quietly put a live feature back to a default, and in
       * this case the default is the safe one but the live value would be lost
       * silently, which is just as bad in the other direction.
       *
       * The Delhivery payload this sends is unverified against a real AWB (no
       * public API reference exists for cmu/create.json), so 'live' should be
       * set only after one cancelled test booking. See DECISIONS T1.
       */
      REPLACE_MODE: ['off', 'shadow', 'live'].includes(props.replaceMode) ? props.replaceMode : 'shadow',
      // Empty means "the owner alert phones", so there is one list to maintain.
      REPLACE_ADMIN_PHONES: props.replaceAdminPhones || '',
      // NON-EMPTY means live mode acts only on these order numbers: the safe
      // way to take the first real booking against one order of your own.
      REPLACE_TEST_ORDERS: props.replaceTestOrders || '',
      REPLACE_REQUIRE_CONFIRM: props.replaceRequireConfirm === false ? 'false' : 'true',
      REPLACE_ALLOW_SKIP_CONFIRM: props.replaceAllowSkipConfirm === true ? 'true' : 'false',
      REPLACE_NOTIFY_CUSTOMER: props.replaceNotifyCustomer === false ? 'false' : 'true',
      REPLACE_SEND_LABEL: props.replaceSendLabel === false ? 'false' : 'true',
      LOGISTICS_PROVIDER: props.logisticsProvider || 'delhivery',
      // Must match the warehouse registered with Delhivery EXACTLY, case
      // included: Delhivery matches it as a string, and a near miss is rejected
      // at create time with a remark rather than silently.
      DELHIVERY_PICKUP_LOCATION: props.delhiveryPickupLocation || '',
      DELHIVERY_SHIPPING_MODE: props.delhiveryShippingMode || 'Surface',
      SELLER_GSTIN: props.sellerGstin || '',
      REPLACE_RETURN_TO_NAME: props.replaceReturnTo?.name || '',
      REPLACE_RETURN_TO_ADDRESS1: props.replaceReturnTo?.address1 || '',
      REPLACE_RETURN_TO_CITY: props.replaceReturnTo?.city || '',
      REPLACE_RETURN_TO_STATE: props.replaceReturnTo?.state || '',
      REPLACE_RETURN_TO_PIN: props.replaceReturnTo?.pin || '',
      REPLACE_RETURN_TO_PHONE: props.replaceReturnTo?.phone || '',
      /*
       * Flow R shadow mode. NON-EMPTY means only these phones are really
       * messaged and every other eligible checkout is logged instead. Set to
       * the owner's own number for the live test, then emptied to go live.
       * Deliberately not SEND_ALLOWLIST, which gates the whatsapp client for
       * the whole service and would have silenced Flow A at the same time.
       */
      FLOW_R_ALLOWLIST: props.cartRecoveryAllowlist || '',
      /*
       * Flow W shadow mode, and it matters more than Flow R's: Flow W is the
       * first thing in this service that messages a number which was never
       * OTP-verified (owner's decision, see src/lib/phone.mjs). Set to the
       * owner's own number for three days, then emptied to go live.
       */
      FLOW_W_ALLOWLIST: props.subscriberOfferAllowlist || '',
      /*
       * Flow W's email fallback. EMPTY means email is simply unavailable,
       * which is a recorded outcome and not an error: WhatsApp still runs. It
       * must be an address on a VERIFIED SES identity, and the IAM statement
       * further down is scoped to that identity and to this exact address.
       *
       * EMAIL_REPLY_TO is a human's mailbox; nothing in this service reads it.
       */
      EMAIL_FROM: props.emailFrom || '',
      EMAIL_REPLY_TO: props.emailReplyTo || '',
      ...Object.fromEntries(
        ['A', 'B', 'C', 'D', 'R', 'W'].flatMap((f) => [
          [`FLOW_${f}_ENABLED`, String(Boolean((props.flows || {})[f]?.enabled))],
          [`FLOW_${f}_START_AT`, (props.flows || {})[f]?.startAt || ''],
        ]),
      ),
      DYNAMO_BACKEND: 'aws',
      QUEUE_BACKEND: 'aws',
      SECRETS_BACKEND: 'aws',
      CONFIG_BACKEND: 'aws',
      TABLE_NAME: table.tableName,
      SECRETS_ID: secret.secretName,
      QUEUE_URL: queue.queueUrl,
      SHOP_DOMAIN: props.shopDomain || '',
      GRAPH_VERSION: props.graphVersion || 'v25.0',
      PUBLIC_BASE_URL: props.publicBaseUrl || '',
      SCHEDULER_ROLE_ARN: schedulerRole.roleArn,
      SCHEDULER_TARGET_ARN: queue.queueArn,
      /*
       * The P&L. These are on EVERY function, not just the report one, because
       * the worker needs PNL_FUNCTION_NAME to hand `/pnl` off and REPORTS_BUCKET
       * to store a ledger the owner sends in as a WhatsApp document.
       */
      PNL_ENABLED: String(props.pnlEnabled === true),
      PNL_ADMIN_PHONES: props.pnlAdminPhones || '',
      PNL_EMAIL_TO: props.pnlEmailTo || '',
      PNL_FUNCTION_NAME: 'wa-pnl-report',
      REPORTS_BUCKET: reports.bucketName,
      META_AD_ACCOUNT_ID: props.metaAdAccountId || '',
      AWS_NODEJS_CONNECTION_REUSE_ENABLED: '1',
    };

    const makeFn = (name, handler, opts = {}) =>
      new lambda.Function(this, name, {
        functionName: `wa-${name}`,
        runtime: lambda.Runtime.NODEJS_24_X,
        code: CODE,
        handler,
        timeout: opts.timeout || Duration.seconds(30),
        memorySize: opts.memory || 256,
        environment: { ...commonEnv, ...(opts.env || {}) },
        reservedConcurrentExecutions: opts.reserved,
        ...(opts.logGroup ? { logGroup: opts.logGroup } : {}),
        ...(opts.layers ? { layers: opts.layers } : {}),
      });

    // ingest (verify + dedupe + 200 fast): need table (dedupe) + queue (send) + secret
    const ingest = {
      shopify: makeFn('ingest-shopify', 'src/ingest/shopify.handler'),
      whatsapp: makeFn('ingest-whatsapp', 'src/ingest/whatsapp.handler'),
      razorpay: makeFn('ingest-razorpay', 'src/ingest/razorpay.handler'),
      delhivery: makeFn('ingest-delhivery', 'src/ingest/delhivery.handler'),
    };
    const redirectFn = makeFn('pay-redirect', 'src/ingest/pay-redirect.handler');
    /*
     * Flow R's "Complete my order" link. Its log group is CREATED here rather
     * than imported like every other one, because a Lambda's log group does not
     * exist until its first invocation and a subscription filter on a missing
     * group fails the whole deploy. Passing it to the function as well makes
     * CloudFormation order the two correctly instead of racing them.
     */
    const cartRedirectLogs = new logs.LogGroup(this, 'CartRedirectLogs', {
      logGroupName: '/aws/lambda/wa-cart-redirect',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const cartRedirectFn = makeFn('cart-redirect', 'src/ingest/cart-redirect.handler', {
      logGroup: cartRedirectLogs,
    });
    /*
     * Flow W's "Shop best sellers" link. Its log group is CREATED here for the
     * same reason as cart-redirect's: a Lambda's log group does not exist
     * until its first invocation, and a subscription filter on a missing group
     * fails the whole deploy.
     */
    const wRedirectLogs = new logs.LogGroup(this, 'WRedirectLogs', {
      logGroupName: '/aws/lambda/wa-w-redirect',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    const wRedirectFn = makeFn('w-redirect', 'src/ingest/w-redirect.handler', {
      logGroup: wRedirectLogs,
    });
    const onboardingFn = makeFn('onboarding', 'src/ingest/onboarding.handler');
    // The storefront signup popup's save endpoint. Public and unsigned (a browser
    // cannot hold an HMAC secret), so it defends itself: origin allowlist, honeypot,
    // per-IP rate limit. No reserved concurrency for the same reason as the worker
    // below -- this account's total limit is 10 and any reservation drops the
    // unreserved pool under AWS's minimum. The per-IP cap is the real throttle.
    // Flow R's PRIMARY source. Shopify only files an AbandonedCheckout once a
    // shopper reaches its own contact step, and COD King's OTP happens before
    // that, so the checkout list never sees anyone who verified and left
    // earlier. The storefront posts those carts here. Public and unsigned for
    // the same reason as /subscribe, and defended the same way: origin
    // allowlist, per-IP rate limit, strict validation. It writes to DynamoDB
    // and calls nothing else, so a bad body cannot reach Shopify from here.
    const cartCaptureFn = makeFn('cart-capture', 'src/ingest/cart-capture.handler', {
      env: { SUBSCRIBE_ORIGINS: 'http://127.0.0.1:9292 http://localhost:9292' },
    });
    const subscribeFn = makeFn('subscribe', 'src/ingest/subscribe.handler', {
      // The live storefront origins are built into the handler. These extras let
      // `shopify theme dev` on localhost reach the endpoint while a change is
      // being tested. Safe to drop: CORS guards the browser, and the honeypot,
      // per-IP rate limit and field validation are what actually guard the route.
      env: { SUBSCRIBE_ORIGINS: 'http://127.0.0.1:9292 http://localhost:9292' },
    });

    // worker (all side effects). No reserved concurrency: this account's total
    // limit is 10 and a reservation would drop the unreserved pool below AWS's
    // minimum. FIFO ordering per MessageGroupId holds regardless, so correctness
    // is unaffected; set `reserved` here only on an account with headroom.
    const worker = makeFn('worker', 'src/worker/index.handler', {
      timeout: Duration.seconds(60),
    });
    worker.addEventSource(new SqsEventSource(queue, { batchSize: 1, reportBatchItemFailures: true }));

    // recurring jobs (created now; handlers land in later phases)
    const pollFn = makeFn('poll-delhivery', 'src/timers/poll-delhivery.handler', { timeout: Duration.seconds(120) });
    const reconcileFn = makeFn('reconcile', 'src/timers/reconcile.handler', { timeout: Duration.seconds(300) });
    const digestFn = makeFn('digest', 'src/timers/digest.handler', { timeout: Duration.seconds(120) });

    /*
     * The monthly P&L. Its log group is CREATED here, like cart-redirect's and
     * w-redirect's, because a Lambda's group does not exist until its first
     * invocation and a subscription filter on a missing group fails the deploy.
     * This one runs once a month, so "never yet invoked" is its normal state
     * for most of any given month.
     */
    const pnlLogs = new logs.LogGroup(this, 'PnlReportLogs', {
      logGroupName: '/aws/lambda/wa-pnl-report',
      retention: logs.RetentionDays.THREE_MONTHS,
      removalPolicy: RemovalPolicy.RETAIN,
    });
    if (!fs.existsSync(path.join(PNL_LAYER_DIR, 'nodejs', 'node_modules', 'exceljs'))) {
      throw new Error(
        `the P&L layer is not built: ${PNL_LAYER_DIR}/nodejs/node_modules/exceljs is missing. ` +
          'Run `npm run pnl:layer` before cdk synth, diff or deploy. Without it wa-pnl-report ' +
          'deploys fine and then throws on its first import, where the only symptom is a report ' +
          'that never arrives.',
      );
    }
    const pnlLayer = new lambda.LayerVersion(this, 'PnlLayer', {
      code: lambda.Code.fromAsset(PNL_LAYER_DIR),
      compatibleRuntimes: [lambda.Runtime.NODEJS_24_X],
      description: 'exceljs, for the monthly P&L workbook',
    });
    /*
     * Ten minutes and 1024 MB: a month is ~70 orders, ~50 tracking calls in
     * batches of 25, a charges call per distinct leg, and then thirteen sheets
     * of exceljs, which is the memory-hungry part.
     *
     * reserved: 1 is the brief's ask and is safe here. The comments above about
     * reservations are from when this account's ceiling was 10; it now reports
     * 1000 concurrent executions, so reserving one leaves 999 unreserved,
     * far above the 100 AWS insists stay in the common pool. It is belt and
     * braces anyway: the real guard against a double run is the PNL#<month>
     * lock in the table, because two triggers a second apart would otherwise
     * both pass a concurrency check.
     */
    const pnlFn = makeFn('pnl-report', 'src/timers/pnl-report.handler', {
      timeout: Duration.minutes(10),
      memory: 1024,
      reserved: 1,
      logGroup: pnlLogs,
      layers: [pnlLayer],
    });

    // ---- grants -----------------------------------------------------------
    const allFns = [...Object.values(ingest), redirectFn, cartRedirectFn, wRedirectFn, onboardingFn, subscribeFn, cartCaptureFn, worker, pollFn, reconcileFn, digestFn, pnlFn];
    for (const fn of allFns) {
      table.grantReadWriteData(fn);
      /*
       * Least privilege where it matters most. cart-capture is reachable from
       * the open internet without a signature, and it talks to DynamoDB and
       * nothing else: no Shopify call, no WhatsApp call, no secret read. So it
       * is the one function that does not get the API credentials, and a flaw
       * in it cannot become a way to read them.
       */
      /*
       * w-redirect joins cart-capture in getting NO secret, for the same
       * reason: it is reachable from the open internet, it reads one DynamoDB
       * row and writes a click count, and it calls no provider at all. A flaw
       * in it must not become a way to read the API credentials.
       */
      if (fn !== cartCaptureFn && fn !== wRedirectFn) secret.grantRead(fn);
    }
    for (const fn of Object.values(ingest)) queue.grantSendMessages(fn);
    // worker + flow-capable fns create/delete one-time schedules and pass the role
    for (const fn of [worker, pollFn, reconcileFn]) {
      queue.grantSendMessages(fn);
      fn.addToRolePolicy(
        new iam.PolicyStatement({
          actions: ['scheduler:CreateSchedule', 'scheduler:DeleteSchedule', 'scheduler:GetSchedule'],
          resources: ['*'],
        }),
      );
      fn.addToRolePolicy(
        new iam.PolicyStatement({ actions: ['iam:PassRole'], resources: [schedulerRole.roleArn] }),
      );
    }

    /*
     * SES, on the WORKER role and nowhere else, because that is where the send
     * happens: reconcile only enqueues. Scoped to the one verified identity
     * and, when EMAIL_FROM is set, to that exact address, so a flaw in a flow
     * cannot send mail as anybody else on the domain.
     *
     * IF THIS EVER DENIES A RECIPIENT, THE ACCOUNT IS BACK IN THE SES SANDBOX.
     * In the sandbox every destination must itself be a verified identity, and
     * SES enforces that by authorising SendEmail against the DESTINATION
     * identity too, so a narrow resource list surfaces as
     *
     *   not authorized to perform 'ses:SendEmail' on resource
     *   'arn:aws:ses:<region>:<acct>:identity/<the RECIPIENT>'
     *
     * which reads like a policy bug and is really "that recipient is not
     * verified". It cost exactly one send, on 2026-10-25, and was briefly
     * "fixed" by widening the resource to identity/*. That was the wrong read:
     * production access landed on 2026-10-26 and this narrow grant then sent to
     * two unverified gmail addresses without complaint, because outside the
     * sandbox SES authorises against the FROM identity only. Widening it bought
     * nothing and gave the role the right to mail anyone from any identity on
     * the account, so it was reverted. Verify with the quota, not the policy:
     * `aws sesv2 get-account` reports ProductionAccessEnabled and Max24HourSend
     * (50000 in production, 200 in the sandbox).
     */
    const emailFrom = String(props.emailFrom || '');
    const emailIdentity = emailFrom.split('@')[1] || 'morpaankh.in';
    /*
     * `raw` adds ses:SendRawEmail, and it is NOT optional for an attachment.
     *
     * SESv2 has ONE SendEmail API, but IAM authorises it against two different
     * actions depending on the content shape: Content.Simple needs
     * ses:SendEmail, Content.Raw needs ses:SendRawEmail. The P&L workbook can
     * only travel as Raw, because Simple has no way to carry a file.
     *
     * Found in production, not in review: the first real report built fine,
     * uploaded fine, and then both email sends failed with "not authorized to
     * perform 'ses:SendRawEmail'". Nothing in the Lambda, the MIME or the
     * bucket was wrong. The worker keeps SendEmail alone because every message
     * it sends is Simple, and there is no reason to let it send raw mail.
     */
    const sesGrant = ({ raw = false } = {}) =>
      new iam.PolicyStatement({
        actions: raw ? ['ses:SendEmail', 'ses:SendRawEmail'] : ['ses:SendEmail'],
        resources: [`arn:aws:ses:${this.region}:${this.account}:identity/${emailIdentity}`],
        ...(emailFrom ? { conditions: { StringEquals: { 'ses:FromAddress': emailFrom } } } : {}),
      });
    worker.addToRolePolicy(sesGrant());
    // The report emails the workbook, always, and it is a different function
    // from the worker, so it needs the same narrow grant of its own. Scoped the
    // same way deliberately: read the long comment above before widening it.
    pnlFn.addToRolePolicy(sesGrant({ raw: true }));

    /*
     * The report reads and writes its bucket. The worker only writes, and only
     * because a ledger arrives as a WhatsApp document it has to store.
     */
    reports.grantReadWrite(pnlFn);
    reports.grantPut(worker);

    /*
     * `/pnl` arrives on the worker, which has 60 seconds. A month of Shopify
     * orders plus fifty tracking calls does not fit, and there is no
     * ack-then-continue mechanism inside the worker, so it acknowledges and
     * invokes the report asynchronously.
     *
     * This is the first lambda:InvokeFunction grant in the service, which is
     * why it is scoped to exactly one function ARN rather than added to the
     * shared loop.
     */
    pnlFn.grantInvoke(worker);

    // ---- HTTP API ---------------------------------------------------------
    const api = new HttpApi(this, 'HttpApi', { apiName: 'wa-automation' });
    const route = (path, methods, fn) =>
      api.addRoutes({ path, methods, integration: new HttpLambdaIntegration(`int${path.replace(/\W/g, '')}`, fn) });
    route('/webhooks/shopify', [HttpMethod.POST], ingest.shopify);
    route('/webhooks/whatsapp', [HttpMethod.GET, HttpMethod.POST], ingest.whatsapp);
    route('/webhooks/razorpay', [HttpMethod.POST], ingest.razorpay);
    route('/webhooks/delhivery', [HttpMethod.POST], ingest.delhivery);
    route('/p/{token}', [HttpMethod.GET], redirectFn);
    route('/r/{token}', [HttpMethod.GET], cartRedirectFn);
    route('/w/{token}', [HttpMethod.GET], wRedirectFn);
    route('/onboarding', [HttpMethod.GET], onboardingFn);
    route('/onboarding/exchange', [HttpMethod.POST], onboardingFn);
    route('/subscribe', [HttpMethod.POST, HttpMethod.OPTIONS], subscribeFn);
    route('/cart-capture', [HttpMethod.POST, HttpMethod.OPTIONS], cartCaptureFn);

    // ---- recurring schedules (IST via cron in UTC) ------------------------
    // Delhivery poll hourly 08:00-22:00 IST == 02:30-16:30 UTC.
    new events.Rule(this, 'PollRule', {
      schedule: events.Schedule.expression('cron(30 2-16 * * ? *)'),
      targets: [new targets.LambdaFunction(pollFn)],
    });
    // Reconciliation 02:30 IST == 21:00 UTC (prev day). Full pass: the order
    // sweep plus webhook subscriptions plus re-tracking every active AWB.
    new events.Rule(this, 'ReconcileRule', {
      schedule: events.Schedule.expression('cron(0 21 * * ? *)'),
      targets: [new targets.LambdaFunction(reconcileFn, { event: events.RuleTargetInput.fromObject({ mode: 'full' }) })],
    });
    // The order sweep alone, every hour. An order whose confirmation was lost has
    // to be found in minutes, not at 02:30 the next morning: the message says
    // "your order is confirmed, reply to cancel", and a day late it is worthless.
    // Nightly was the only pass before, and it did not look at orders at all.
    /*
     * Every 10 minutes, not hourly. A missed webhook used to mean the customer
     * waited up to an hour for the confirmation of an order they had just
     * placed, which is worth almost nothing by the time it lands. The sweep
     * itself only re-arms orders with neither a confirmation nor a recorded
     * skip, and RETRY_SPACING_MINUTES keeps each order's retry budget on the
     * same hourly footing it had before.
     */
    new events.Rule(this, 'ReconcileOrdersRule', {
      schedule: events.Schedule.rate(Duration.minutes(10)),
      targets: [new targets.LambdaFunction(reconcileFn, { event: events.RuleTargetInput.fromObject({ mode: 'orders' }) })],
    });
    /*
     * Flow R's cart sweep, every five minutes, all day.
     *
     * Deliberately NOT narrowed to the send window in cron. The window lives in
     * RULES.cartRecovery.sendWindow and the sweep checks it itself, so putting
     * the same hours in a cron expression would be a second source of truth
     * that silently stops following the first one. Outside the window the
     * invocation returns in milliseconds.
     *
     * `mode: 'carts'` is handled and RETURNED at the very top of the reconcile
     * handler. Anything else falls through to the full nightly pass, which
     * sends review asks.
     */
    new events.Rule(this, 'CartSweepRule', {
      schedule: events.Schedule.rate(Duration.minutes(5)),
      targets: [new targets.LambdaFunction(reconcileFn, { event: events.RuleTargetInput.fromObject({ mode: 'carts' }) })],
    });
    /*
     * Flow W's subscriber sweep, once a day. cron(30 5 * * ? *) is 05:30 UTC,
     * which is 11:00 IST.
     *
     * `mode: 'subscribers'` is handled and RETURNED at the very top of the
     * reconcile handler. Anything it does not recognise collapses to the full
     * nightly pass, which calls sweepUnreviewed() and SENDS review asks to
     * real customers.
     *
     * 11:00 and not midnight because the sweep reads YESTERDAY as an IST
     * calendar day: a run at 00:30 would be asking the customers search index
     * about a day that ended thirty minutes ago, and that index lags a create
     * by seconds. By 11:00 it is settled, and 11:00 is inside the send window
     * so the offers go out immediately rather than sitting on a timer.
     */
    new events.Rule(this, 'SubscriberSweepRule', {
      schedule: events.Schedule.expression('cron(30 5 * * ? *)'),
      targets: [new targets.LambdaFunction(reconcileFn, { event: events.RuleTargetInput.fromObject({ mode: 'subscribers' }) })],
    });
    // Digest 09:30 IST == 04:00 UTC.
    new events.Rule(this, 'DigestRule', {
      schedule: events.Schedule.expression('cron(0 4 * * ? *)'),
      targets: [new targets.LambdaFunction(digestFn)],
    });

    // ---- alarms -> SNS ----------------------------------------------------
    const topic = new sns.Topic(this, 'Alerts', { topicName: 'wa-automation-alerts' });
    // alertEmail accepts a comma/space separated list so more than one person
    // gets paged. Each address must click the AWS confirmation mail once.
    for (const addr of String(props.alertEmail || '').split(/[,\s]+/).filter(Boolean)) {
      topic.addSubscription(new subs.EmailSubscription(addr));
    }
    const alarmAction = new cwActions.SnsAction(topic);

    // ---- error reporter ---------------------------------------------------
    // An alarm email says "wa-worker-errors went to ALARM" and nothing else, so
    // every incident used to start with a trip to CloudWatch. This function
    // receives the actual error lines through log subscription filters and
    // emails them with the order, the flow, the step and a link to the stream.
    //
    // It runs entirely out of band: it reads logs after the fact, so it cannot
    // slow down or fail anything a customer is waiting on, and it is NOT
    // subscribed to its own log group, so it cannot feed itself.
    const errorReporter = makeFn('error-reporter', 'src/ops/error-reporter.handler', {
      env: { ALERT_TOPIC_ARN: topic.topicArn },
    });
    table.grantReadWriteData(errorReporter); // throttling ledger
    topic.grantPublish(errorReporter);
    // Needed for the WhatsApp owner ping. This function is created after the
    // shared grant loop above, so it has to ask for the secret explicitly.
    secret.grantRead(errorReporter);

    // Log groups are created here only so the subscription filters have
    // something to attach to; Lambda writes to these same names by convention.
    // Every function is covered, including ones that have never been invoked.
    const reported = [
      'wa-worker',
      'wa-ingest-shopify',
      'wa-ingest-whatsapp',
      'wa-ingest-razorpay',
      'wa-ingest-delhivery',
      'wa-pay-redirect',
      'wa-onboarding',
      // Added late, and missed by this list for two days: a failed signup save
      // is caught and answered as a 502, so it raises no Lambda error and no
      // alarm. This filter is the only thing that tells anyone about it.
      'wa-subscribe',
      'wa-poll-delhivery',
      'wa-reconcile',
      'wa-digest',
      /*
       * Flow R's PRIMARY source, and it was in neither this list nor any alarm.
       *
       * A storefront capture failure is CAUGHT and answered as a 502, exactly
       * like wa-subscribe, so it raises no Lambda error and tripped nothing.
       * A broken deploy here silently kills most of the cart recovery the flow
       * exists for, and the only evidence would be carts quietly not being
       * messaged. It is also where the flood alerts from the new per-phone and
       * per-hour caps land, so without this line those alerts reach nobody.
       *
       * IMPORTED, not created. This function has run, so its log group already
       * exists and `new logs.LogGroup` with that name fails the deploy with
       * AlreadyExists.
       */
      'wa-cart-capture',
    ];
    const reportedGroups = [
      ...reported.map((name) => [name, logs.LogGroup.fromLogGroupName(this, `Lg${name}`, `/aws/lambda/${name}`)]),
      // The groups this stack owns rather than imports.
      ['wa-cart-redirect', cartRedirectLogs],
      ['wa-w-redirect', wRedirectLogs],
      // Without this line a failed monthly report would be silent until
      // somebody noticed the email had not arrived, which is the same hole
      // wa-subscribe sat in for two days.
      ['wa-pnl-report', pnlLogs],
    ];
    for (const [name, lg] of reportedGroups) {
      // Two filters, which is the per-log-group maximum. The first catches our
      // own structured errors; the second catches the failures that happen
      // before any of our code runs (a syntax error in a bad deploy, an import
      // failure, a timeout) which is exactly the class that once killed the
      // worker silently for hours.
      lg.addSubscriptionFilter(`SubApp${name}`, {
        destination: new logDests.LambdaDestination(errorReporter),
        filterPattern: logs.FilterPattern.literal('{ $.level = "error" }'),
      });
      lg.addSubscriptionFilter(`SubCrash${name}`, {
        destination: new logDests.LambdaDestination(errorReporter),
        filterPattern: logs.FilterPattern.literal('?"Task timed out" ?"Runtime." ?"[ERROR]"'),
      });
    }

    const alarm = (name, metric, threshold, opts = {}) => {
      const a = new cw.Alarm(this, name, {
        alarmName: `wa-${name}`,
        metric,
        threshold,
        evaluationPeriods: opts.periods || 1,
        comparisonOperator: cw.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
        treatMissingData: cw.TreatMissingData.NOT_BREACHING,
      });
      a.addAlarmAction(alarmAction);
      return a;
    };
    alarm('worker-errors', worker.metricErrors({ period: Duration.minutes(5) }), 1);
    alarm('dlq-not-empty', dlq.metricApproximateNumberOfMessagesVisible({ period: Duration.minutes(5) }), 1);
    const emf = (metricName) =>
      new cw.Metric({ namespace: 'WAAutomation', metricName, statistic: 'Sum', period: Duration.minutes(15) });
    // Threshold 1, not 5. This store takes one or two orders a day, so five
    // failed sends inside one 15-minute window is not reachable: on 26 Sept
    // EVERY confirmation failed to deliver and this alarm stayed green, because
    // two is not five. At this volume a single customer who was not reached is
    // worth an email.
    //
    // What the threshold counts was narrowed on 29 Oct 2026, which is what
    // makes it survivable. MessageFailed is now emitted ONLY for failures this
    // service did not recover from; a 131049, 130472 or 131026 that parked and
    // fell back to email is counted as MessageFailedHandled instead (see
    // onWaStatus). Meta refuses roughly a third of this store's sends that way,
    // so before the split this alarm mailed the owner several times a day for
    // working behaviour, and the owner stopped reading it.
    alarm('whatsapp-failures', emf('MessageFailed'), 1);
    alarm('courier-failures', emf('CourierError'), 5);

    // Only the worker was alarmed before, so an ingest Lambda that threw on
    // every invocation (a bad deploy, a Secrets Manager outage) would 5xx every
    // webhook, the provider would retry, give up, and the events would be lost
    // with nothing alerting. One alarm over the sum of errors across every
    // other function closes that.
    // CloudWatch allows at most 10 individual metrics in an alarm math
    // expression, and this list was already at 9, which is why the two public
    // intake endpoints could not simply be appended: synth fails with
    // TooManyMetricsInMathExpression at 11. They get their own alarm instead,
    // which is a truer grouping anyway - both are public HTTP endpoints that
    // sit outside the queue-driven pipeline. The worker is in neither list on
    // purpose, it has its own alarm above.
    const pipelineFns = [...Object.values(ingest), redirectFn, pollFn, reconcileFn, digestFn, errorReporter];
    // cart-redirect joins THIS list and not pipelineFns, which is already at 9
    // of CloudWatch's 10-metric ceiling for an alarm math expression. It is
    // also the truer grouping: like the other two, it is a public HTTP endpoint
    // a customer hits directly rather than a queue-driven step.
    // w-redirect joins intakeFns for both reasons: pipelineFns is at 9 of
    // CloudWatch's 10-metric ceiling, and this is the truer grouping anyway,
    // since it is a public HTTP endpoint a customer taps rather than a
    // queue-driven step.
    // cart-capture joins intakeFns for the same two reasons as the others:
    // pipelineFns is at 9 of CloudWatch's 10-metric ceiling, and this is a
    // public HTTP endpoint a shopper's browser posts to, not a queue step.
    // Five of the ten slots used.
    const intakeFns = [onboardingFn, subscribeFn, cartRedirectFn, wRedirectFn, cartCaptureFn];
    const sumErrors = (fns) =>
      new cw.MathExpression({
        expression: fns.map((_, i) => `e${i}`).join(' + '),
        usingMetrics: Object.fromEntries(
          fns.map((f, i) => [`e${i}`, f.metricErrors({ period: Duration.minutes(5) })]),
        ),
        period: Duration.minutes(5),
      });
    if (pipelineFns.length > 10 || intakeFns.length > 10) {
      throw new Error('alarm math expression limit is 10 metrics; split the list further');
    }
    alarm('function-errors', sumErrors(pipelineFns), 1);
    // subscribe is the signup popup's ONLY save path and it answers 502 on a
    // caught failure, so it raises no Lambda error either. Nothing alarmed it,
    // so an uncaught failure, a bad deploy or a Secrets Manager outage, would
    // have taken the whole subscriber list offline silently.
    alarm('intake-errors', sumErrors(intakeFns), 1);
    /*
     * Its own alarm rather than a seat in pipelineFns, which is at 9 of
     * CloudWatch's 10-metric ceiling for a math expression. Taking the last
     * slot would leave the next function with nowhere to go, and a once-a-month
     * job is worth watching on its own anyway: it has eleven chances a year to
     * be noticed, so a missed failure is a missed month.
     */
    alarm('pnl-errors', pnlFn.metricErrors({ period: Duration.minutes(5) }), 1);

    /*
     * The 7th at 09:00 IST, for the month before. The 7th rather than the 1st
     * so late-settling parcels from the end of the month have had a week to
     * finish moving: a report run on the 1st would call a third of the month
     * pending and be restated immediately.
     */
    new events.Rule(this, 'PnlMonthlyRule', {
      ruleName: 'wa-pnl-monthly',
      schedule: events.Schedule.expression('cron(30 3 7 * ? *)'), // 09:00 IST on the 7th
      targets: [new targets.LambdaFunction(pnlFn, { event: events.RuleTargetInput.fromObject({ trigger: 'schedule' }) })],
    });

    // ---- outputs ----------------------------------------------------------
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'QueueUrl', { value: queue.queueUrl });
    new cdk.CfnOutput(this, 'SecretsName', { value: secret.secretName });
    new cdk.CfnOutput(this, 'SchedulerRoleArn', { value: schedulerRole.roleArn });
    new cdk.CfnOutput(this, 'ReportsBucket', { value: reports.bucketName });
  }
}

module.exports = { WaAutomationStack };
