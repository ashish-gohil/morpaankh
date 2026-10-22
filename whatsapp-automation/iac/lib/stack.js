'use strict';
/*
 * WaAutomationStack — all infrastructure for the whatsapp-automation service.
 * Safe by default: DRY_RUN=true on every Lambda, flows OFF (flags live in the
 * runtime config item / env), data resources RETAINed. Nothing here sends a
 * message or moves money; that is gated by config the operator flips later.
 */
const path = require('path');
const cdk = require('aws-cdk-lib');
const { Duration, RemovalPolicy } = cdk;
const dynamodb = require('aws-cdk-lib/aws-dynamodb');
const sqs = require('aws-cdk-lib/aws-sqs');
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

class WaAutomationStack extends cdk.Stack {
  constructor(scope, id, props = {}) {
    super(scope, id, props);

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
      ...Object.fromEntries(
        ['A', 'B', 'C', 'D', 'R'].flatMap((f) => [
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

    // ---- grants -----------------------------------------------------------
    const allFns = [...Object.values(ingest), redirectFn, cartRedirectFn, onboardingFn, subscribeFn, cartCaptureFn, worker, pollFn, reconcileFn, digestFn];
    for (const fn of allFns) {
      table.grantReadWriteData(fn);
      /*
       * Least privilege where it matters most. cart-capture is reachable from
       * the open internet without a signature, and it talks to DynamoDB and
       * nothing else: no Shopify call, no WhatsApp call, no secret read. So it
       * is the one function that does not get the API credentials, and a flaw
       * in it cannot become a way to read them.
       */
      if (fn !== cartCaptureFn) secret.grantRead(fn);
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
    new events.Rule(this, 'ReconcileOrdersRule', {
      schedule: events.Schedule.expression('cron(15 * * * ? *)'),
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
    ];
    const reportedGroups = [
      ...reported.map((name) => [name, logs.LogGroup.fromLogGroupName(this, `Lg${name}`, `/aws/lambda/${name}`)]),
      // The one group this stack owns rather than imports.
      ['wa-cart-redirect', cartRedirectLogs],
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
    const intakeFns = [onboardingFn, subscribeFn, cartRedirectFn];
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

    // ---- outputs ----------------------------------------------------------
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'QueueUrl', { value: queue.queueUrl });
    new cdk.CfnOutput(this, 'SecretsName', { value: secret.secretName });
    new cdk.CfnOutput(this, 'SchedulerRoleArn', { value: schedulerRole.roleArn });
  }
}

module.exports = { WaAutomationStack };
