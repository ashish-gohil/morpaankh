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
      contentBasedDeduplication: false,
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
      DRY_RUN: 'true',
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
      });

    // ingest (verify + dedupe + 200 fast): need table (dedupe) + queue (send) + secret
    const ingest = {
      shopify: makeFn('ingest-shopify', 'src/ingest/shopify.handler'),
      whatsapp: makeFn('ingest-whatsapp', 'src/ingest/whatsapp.handler'),
      razorpay: makeFn('ingest-razorpay', 'src/ingest/razorpay.handler'),
      delhivery: makeFn('ingest-delhivery', 'src/ingest/delhivery.handler'),
    };
    const redirectFn = makeFn('pay-redirect', 'src/ingest/pay-redirect.handler');
    const onboardingFn = makeFn('onboarding', 'src/ingest/onboarding.handler');

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
    const allFns = [...Object.values(ingest), redirectFn, onboardingFn, worker, pollFn, reconcileFn, digestFn];
    for (const fn of allFns) {
      table.grantReadWriteData(fn);
      secret.grantRead(fn);
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
    route('/onboarding', [HttpMethod.GET], onboardingFn);
    route('/onboarding/exchange', [HttpMethod.POST], onboardingFn);

    // ---- recurring schedules (IST via cron in UTC) ------------------------
    // Delhivery poll hourly 08:00-22:00 IST == 02:30-16:30 UTC.
    new events.Rule(this, 'PollRule', {
      schedule: events.Schedule.expression('cron(30 2-16 * * ? *)'),
      targets: [new targets.LambdaFunction(pollFn)],
    });
    // Reconciliation 02:30 IST == 21:00 UTC (prev day).
    new events.Rule(this, 'ReconcileRule', {
      schedule: events.Schedule.expression('cron(0 21 * * ? *)'),
      targets: [new targets.LambdaFunction(reconcileFn)],
    });
    // Digest 09:30 IST == 04:00 UTC.
    new events.Rule(this, 'DigestRule', {
      schedule: events.Schedule.expression('cron(0 4 * * ? *)'),
      targets: [new targets.LambdaFunction(digestFn)],
    });

    // ---- alarms -> SNS ----------------------------------------------------
    const topic = new sns.Topic(this, 'Alerts', { topicName: 'wa-automation-alerts' });
    if (props.alertEmail) topic.addSubscription(new subs.EmailSubscription(props.alertEmail));
    const alarmAction = new cwActions.SnsAction(topic);

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
    alarm('whatsapp-failures', emf('MessageFailed'), 5);
    alarm('courier-failures', emf('CourierError'), 5);

    // ---- outputs ----------------------------------------------------------
    new cdk.CfnOutput(this, 'ApiUrl', { value: api.apiEndpoint });
    new cdk.CfnOutput(this, 'TableName', { value: table.tableName });
    new cdk.CfnOutput(this, 'QueueUrl', { value: queue.queueUrl });
    new cdk.CfnOutput(this, 'SecretsName', { value: secret.secretName });
    new cdk.CfnOutput(this, 'SchedulerRoleArn', { value: schedulerRole.roleArn });
  }
}

module.exports = { WaAutomationStack };
