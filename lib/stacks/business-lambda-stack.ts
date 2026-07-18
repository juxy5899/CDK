import * as path from 'path';
import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as sqs from 'aws-cdk-lib/aws-sqs';
import * as events from 'aws-cdk-lib/aws-events';
import * as lambda from 'aws-cdk-lib/aws-lambda';
import * as lambdaEventSources from 'aws-cdk-lib/aws-lambda-event-sources';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudwatch from 'aws-cdk-lib/aws-cloudwatch';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as secretsmanager from 'aws-cdk-lib/aws-secretsmanager';
import { Construct } from 'constructs';
import { EnvConfig, buildResourceName, isPlaceholder } from '../config/env-config';

export interface BusinessLambdaStackProps extends cdk.StackProps {
  envName: string;
  envConfig: EnvConfig;
  vpc: ec2.IVpc;
  mediaBucket: s3.IBucket;
  auroraSecret: secretsmanager.ISecret;
  auroraSecurityGroup: ec2.ISecurityGroup;
  eventBus: events.IEventBus;
  eventQueue: sqs.IQueue;
}

export class BusinessLambdaStack extends cdk.Stack {
  /** イベント処理 Lambda */
  public readonly eventProcessor: lambda.Function;

  constructor(scope: Construct, id: string, props: BusinessLambdaStackProps) {
    super(scope, id, props);

    const {
      envName,
      envConfig,
      vpc,
      mediaBucket,
      auroraSecret,
      auroraSecurityGroup,
      eventBus,
      eventQueue,
    } = props;

    const functionName = buildResourceName(envName, 'event-processor');
    const logGroup = new logs.LogGroup(this, 'EventProcessorLogGroup', {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    const eventProcessorSg = new ec2.SecurityGroup(this, 'EventProcessorSg', {
      vpc,
      description: 'Security group for event processor Lambda',
    });

    new ec2.CfnSecurityGroupIngress(this, 'AuroraIngressFromEventProcessor', {
      groupId: auroraSecurityGroup.securityGroupId,
      sourceSecurityGroupId: eventProcessorSg.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 3306,
      toPort: 3306,
      description: 'Allow MySQL access from EventProcessor Lambda',
    });

    this.eventProcessor = new lambda.Function(this, 'EventProcessorFunction', {
      functionName,
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromAsset(path.join(__dirname, '../../lambda/event-processor')),
      handler: 'handler.handler',
      timeout: cdk.Duration.seconds(envConfig.eventProcessorTimeoutSec),
      memorySize: envConfig.eventProcessorMemoryMiB,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [eventProcessorSg],
      environment: {
        APP_ENV: envName,
        ENABLE_EVENT_PROCESSING: String(envConfig.enableEventProcessing),
        EVENT_BUS_NAME: eventBus.eventBusName,
        EVENT_QUEUE_NAME: eventQueue.queueName,
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
      new lambdaEventSources.SqsEventSource(eventQueue, {
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
        resources: [eventQueue.queueArn],
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
  }
}