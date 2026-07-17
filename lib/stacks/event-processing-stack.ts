import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { EnvConfig, buildResourceName, isPlaceholder } from '../config/env-config';

export interface EventProcessingStackProps extends cdk.StackProps {
  envName: string;
  envConfig: EnvConfig;
  vpc: ec2.IVpc;
  mediaBucket: s3.IBucket;
  auroraSecret: secretsmanager.ISecret;
}

export class EventProcessingStack extends cdk.Stack {
  /** カスタム EventBridge バス */
  public readonly eventBus: events.EventBus;
  /** メインイベントキュー */
  public readonly eventQueue: sqs.Queue;
  /** デッドレターキュー */
  public readonly eventDlq: sqs.Queue;
  /** イベント処理 Lambda */
  public readonly eventProcessor: lambda.Function;

  constructor(scope: Construct, id: string, props: EventProcessingStackProps) {
    super(scope, id, props);

    const { envName, envConfig, vpc, mediaBucket, auroraSecret } = props;

    const eventBusName =
      envConfig.eventBusName && envConfig.eventBusName.trim().length > 0
        ? envConfig.eventBusName
        : buildResourceName(envName, 'event-bus');

    this.eventBus = new events.EventBus(this, 'EventBus', {
      eventBusName,
    });

    this.eventDlq = new sqs.Queue(this, 'EventDlq', {
      queueName: buildResourceName(envName, 'event-dlq').toLowerCase(),
      retentionPeriod: cdk.Duration.days(envConfig.eventQueueRetentionDays),
    });

    this.eventQueue = new sqs.Queue(this, 'EventQueue', {
      queueName: buildResourceName(envName, 'event-queue').toLowerCase(),
      visibilityTimeout: cdk.Duration.seconds(envConfig.eventQueueVisibilityTimeoutSec),
      retentionPeriod: cdk.Duration.days(envConfig.eventQueueRetentionDays),
      deadLetterQueue: {
        queue: this.eventDlq,
        maxReceiveCount: envConfig.eventDlqMaxReceiveCount,
      },
    });

    const businessEventRule = new events.Rule(this, 'BusinessEventRule', {
      eventBus: this.eventBus,
      enabled: envConfig.enableEventProcessing,
      eventPattern: {
        source: ['mti.app'],
        detailType: ['BusinessEvent'],
      },
      targets: [new targets.SqsQueue(this.eventQueue)],
    });

    const functionName = buildResourceName(envName, 'event-processor');
    const logGroup = new logs.LogGroup(this, 'EventProcessorLogGroup', {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    this.eventProcessor = new lambda.Function(this, 'EventProcessorFunction', {
      functionName,
      runtime: lambda.Runtime.NODEJS_20_X,
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/event-processor')),
      handler: 'index.handler',
      timeout: cdk.Duration.seconds(envConfig.eventProcessorTimeoutSec),
      memorySize: envConfig.eventProcessorMemoryMiB,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      environment: {
        APP_ENV: envName,
        ENABLE_EVENT_PROCESSING: String(envConfig.enableEventProcessing),
        EVENT_BUS_NAME: this.eventBus.eventBusName,
        EVENT_QUEUE_NAME: this.eventQueue.queueName,
        DB_SECRET_ARN: auroraSecret.secretArn,
        VIDEO_BUCKET_NAME: mediaBucket.bucketName,
        VIDEO_UPLOAD_PREFIX: envConfig.videoUploadPrefix,
        MEDIA_OUTPUT_PREFIX: envConfig.mediaOutputPrefix,
        VPC_ID: vpc.vpcId,
        MEDIACONVERT_ENDPOINT: envConfig.mediaConvertEndpoint,
        MEDIACONVERT_ROLE_ARN: envConfig.mediaConvertRoleArn,
        PUSH_APPLICATION_ID: envConfig.pushApplicationId,
        PUSH_CREDENTIALS_SECRET_ARN: envConfig.pushCredentialsSecretArn,
      },
    });

    this.eventProcessor.addEventSource(
      new lambdaEventSources.SqsEventSource(this.eventQueue, {
        enabled: envConfig.enableEventProcessing,
      }),
    );

    auroraSecret.grantRead(this.eventProcessor);
    mediaBucket.grantReadWrite(this.eventProcessor);

    this.eventProcessor.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'EventProcessorLogsWrite',
        effect: iam.Effect.ALLOW,
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`${logGroup.logGroupArn}:*`],
      }),
    );

    this.eventProcessor.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'EventQueueConsume',
        effect: iam.Effect.ALLOW,
        actions: [
          'sqs:ReceiveMessage',
          'sqs:DeleteMessage',
          'sqs:GetQueueAttributes',
          'sqs:ChangeMessageVisibility',
        ],
        resources: [this.eventQueue.queueArn],
      }),
    );

    const mediaConvertRoleIsPlaceholder = isPlaceholder(envConfig.mediaConvertRoleArn);

    this.eventProcessor.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'MediaConvertCreateJob',
        effect: iam.Effect.ALLOW,
        actions: ['mediaconvert:CreateJob'],
        resources: ['*'],
        conditions: mediaConvertRoleIsPlaceholder
          ? undefined
          : {
              StringEquals: {
                'mediaconvert:Role': envConfig.mediaConvertRoleArn,
              },
            },
      }),
    );

    // MediaConvert ジョブ実行時に指定する IAM ロールの PassRole 権限を最小化する
    this.eventProcessor.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'MediaConvertPassRole',
        effect: iam.Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [mediaConvertRoleIsPlaceholder ? '*' : envConfig.mediaConvertRoleArn],
        conditions: {
          StringEquals: {
            'iam:PassedToService': 'mediaconvert.amazonaws.com',
          },
        },
      }),
    );

    this.eventProcessor.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'PushPlaceholderActions',
        effect: iam.Effect.ALLOW,
        actions: ['mobiletargeting:SendMessages'],
        resources: ['*'],
      }),
    );

    // pushCredentialsSecretArn が未確定時はプレースホルダーとして '*' を許可し、確定後に ARN スコープへ絞る。
    const secretResourceArn = isPlaceholder(envConfig.pushCredentialsSecretArn)
      ? '*'
      : envConfig.pushCredentialsSecretArn;
    this.eventProcessor.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'PushCredentialsRead',
        effect: iam.Effect.ALLOW,
        actions: ['secretsmanager:GetSecretValue'],
        resources: [secretResourceArn],
      }),
    );

    const mediaConvertStatusRule = new events.Rule(this, 'MediaConvertStatusRule', {
      enabled: envConfig.enableEventProcessing,
      eventPattern: {
        source: ['aws.mediaconvert'],
      },
      targets: [new targets.SqsQueue(this.eventQueue)],
    });

    new cloudwatch.Alarm(this, 'EventProcessorErrorsAlarm', {
      alarmName: buildResourceName(envName, 'event-processor-errors'),
      metric: this.eventProcessor.metricErrors({
        period: cdk.Duration.minutes(5),
        statistic: 'sum',
      }),
      threshold: 0,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
    });

    new cloudwatch.Alarm(this, 'EventDlqVisibleMessagesAlarm', {
      alarmName: buildResourceName(envName, 'event-dlq-visible-messages'),
      metric: this.eventDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: 'maximum',
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
    });

    new cloudwatch.Alarm(this, 'BusinessEventRuleFailedInvocationsAlarm', {
      alarmName: buildResourceName(envName, 'business-event-rule-failed-invocations'),
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Events',
        metricName: 'FailedInvocations',
        dimensionsMap: {
          RuleName: businessEventRule.ruleName,
          EventBusName: this.eventBus.eventBusName,
        },
        statistic: 'sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
    });

    new cloudwatch.Alarm(this, 'MediaConvertStatusRuleFailedInvocationsAlarm', {
      alarmName: buildResourceName(envName, 'mediaconvert-status-rule-failed-invocations'),
      metric: new cloudwatch.Metric({
        namespace: 'AWS/Events',
        metricName: 'FailedInvocations',
        dimensionsMap: {
          RuleName: mediaConvertStatusRule.ruleName,
          EventBusName: 'default',
        },
        statistic: 'sum',
        period: cdk.Duration.minutes(5),
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
    });

  }
}
