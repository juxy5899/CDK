import * as cdk from 'aws-cdk-lib';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as targets from 'aws-cdk-lib/aws-events-targets';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import { Construct } from 'constructs';
import { EnvConfig, buildResourceName } from '../config/env-config';

export interface EventProcessingStackProps extends cdk.StackProps {
  envName: string;
  envConfig: EnvConfig;
}

export class EventProcessingStack extends cdk.Stack {
  /** カスタム EventBridge バス */
  public readonly eventBus: events.EventBus;
  /** メインイベントキュー */
  public readonly eventQueue: sqs.Queue;
  /** デッドレターキュー */
  public readonly eventDlq: sqs.Queue;

  constructor(scope: Construct, id: string, props: EventProcessingStackProps) {
    super(scope, id, props);

    const { envName, envConfig } = props;

    const eventBusProps: events.EventBusProps =
      envConfig.eventBusName && envConfig.eventBusName.trim().length > 0
        ? { eventBusName: envConfig.eventBusName }
        : {};
    const dlqRemovalPolicy = envName === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    this.eventBus = new events.EventBus(this, 'EventBus', eventBusProps);

    this.eventDlq = new sqs.Queue(this, 'EventDlq', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: cdk.Duration.days(envConfig.eventQueueRetentionDays),
      removalPolicy: dlqRemovalPolicy,
    });

    this.eventQueue = new sqs.Queue(this, 'EventQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
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
        source: ['mti.asahimyapp'],
        detailType: ['BusinessEvent'],
      },
      targets: [new targets.SqsQueue(this.eventQueue)],
    });

    const mediaConvertStatusRule = new events.Rule(this, 'MediaConvertStatusRule', {
      enabled: envConfig.enableEventProcessing,
      eventPattern: {
        source: ['aws.mediaconvert'],
        detailType: ['MediaConvert Job State Change'],
      },
      targets: [new targets.SqsQueue(this.eventQueue)],
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
