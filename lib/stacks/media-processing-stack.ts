import * as path from 'path';
import { copyFileSync } from 'fs';
import { execFileSync } from 'child_process';
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
import { EnvConfig, buildResourceName } from '../config/env-config';

export interface MediaProcessingStackProps extends cdk.StackProps {
  envName: string;
  envConfig: EnvConfig;
  vpc: ec2.IVpc;
  mediaBucket: s3.IBucket;
  auroraSecret: secretsmanager.ISecret;
  auroraSecurityGroup: ec2.ISecurityGroup;
}

/**
 * MediaProcessingStack は media upload 後続処理の Queue、DLQ、EventBridge rule、Lambda、監視を定義する。
 * Spring Boot は mediaQueue へ直接送信し、MediaConvert の状態イベントは default bus の rule から mediaQueue へ配送する。
 */
export class MediaProcessingStack extends cdk.Stack {
  /** 管理 Web API と MediaConvert 状態イベントから media 処理要求を受けるキュー */
  public readonly mediaQueue: sqs.Queue;
  /** media 処理の再試行上限を超えたメッセージを退避する DLQ */
  public readonly mediaDlq: sqs.Queue;
  /** media upload と MediaConvert 状態イベントを処理する Lambda */
  public readonly mediaEventProcessor: lambda.Function;

  constructor(scope: Construct, id: string, props: MediaProcessingStackProps) {
    super(scope, id, props);

    const { envName, envConfig, vpc, mediaBucket, auroraSecret, auroraSecurityGroup } = props;
    const dlqRemovalPolicy =
      envName === 'prod' ? cdk.RemovalPolicy.RETAIN : cdk.RemovalPolicy.DESTROY;

    // ────────────────────────────────────────────────
    // Media 処理 Queue / DLQ
    // Spring Boot の upload-complete API と MediaConvert 状態 rule から media 処理要求を受け付ける
    // ────────────────────────────────────────────────
    this.mediaDlq = new sqs.Queue(this, 'MediaDlq', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      retentionPeriod: cdk.Duration.days(envConfig.eventQueueRetentionDays),
      removalPolicy: dlqRemovalPolicy,
    });

    this.mediaQueue = new sqs.Queue(this, 'MediaQueue', {
      encryption: sqs.QueueEncryption.SQS_MANAGED,
      visibilityTimeout: cdk.Duration.seconds(envConfig.eventQueueVisibilityTimeoutSec),
      retentionPeriod: cdk.Duration.days(envConfig.eventQueueRetentionDays),
      deadLetterQueue: {
        queue: this.mediaDlq,
        maxReceiveCount: envConfig.eventDlqMaxReceiveCount,
      },
    });

    // ────────────────────────────────────────────────
    // EventBridge rule
    // default bus の MediaConvert 状態 event を mediaQueue に配送する
    // ────────────────────────────────────────────────
    const mediaConvertStatusRule = new events.Rule(this, 'MediaConvertStatusRule', {
      enabled: envConfig.enableMediaProcessing,
      eventPattern: {
        source: ['aws.mediaconvert'],
        detailType: ['MediaConvert Job State Change'],
      },
      targets: [new targets.SqsQueue(this.mediaQueue)],
    });

    // ────────────────────────────────────────────────
    // MediaConvert 実行ロール
    // MediaConvert job が upload 入力を読み取り、公開 prefix へ HLS 出力を書き込む
    // ────────────────────────────────────────────────
    const mediaConvertJobRole = new iam.Role(this, 'MediaConvertJobRole', {
      roleName: buildResourceName(envName, 'mediaconvert-job-role'),
      assumedBy: new iam.ServicePrincipal('mediaconvert.amazonaws.com'),
    });
    mediaBucket.grantRead(mediaConvertJobRole, `${envConfig.videoUploadPrefix}*`);
    mediaBucket.grantWrite(mediaConvertJobRole, `${envConfig.mediaOutputPrefix}*`);

    // ────────────────────────────────────────────────
    // Media Event Processor Lambda ログ
    // 関数削除後も調査できるよう LogGroup は明示作成し、保持期間と削除方針を固定する
    // ────────────────────────────────────────────────
    const functionName = buildResourceName(envName, 'media-event-processor');
    const logGroup = new logs.LogGroup(this, 'MediaEventProcessorLogGroup', {
      logGroupName: `/aws/lambda/${functionName}`,
      retention: logs.RetentionDays.ONE_MONTH,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ────────────────────────────────────────────────
    // Lambda セキュリティグループ
    // Aurora への接続元を Lambda 専用 SG に限定し、DB 側 ingress はこの Stack で追加する
    // ────────────────────────────────────────────────
    const mediaEventProcessorSg = new ec2.SecurityGroup(this, 'MediaEventProcessorSg', {
      vpc,
      description: 'Security group for media event processor Lambda',
    });

    new ec2.CfnSecurityGroupIngress(this, 'AuroraIngressFromMediaEventProcessor', {
      groupId: auroraSecurityGroup.securityGroupId,
      sourceSecurityGroupId: mediaEventProcessorSg.securityGroupId,
      ipProtocol: 'tcp',
      fromPort: 3306,
      toPort: 3306,
      description: 'Allow MySQL access from MediaEventProcessor Lambda',
    });

    // ────────────────────────────────────────────────
    // Media Event Processor Lambda
    // mediaQueue から upload 処理要求と MediaConvert 状態通知を受信し、S3 / DB / MediaConvert を更新する
    // ────────────────────────────────────────────────
    const mediaEventProcessorSourcePath = path.join(
      __dirname,
      '../../../lambda-services/media-event-processor',
    );
    this.mediaEventProcessor = new lambda.Function(this, 'MediaEventProcessorFunction', {
      functionName,
      runtime: lambda.Runtime.PYTHON_3_12,
      code: lambda.Code.fromAsset(mediaEventProcessorSourcePath, {
        bundling: {
          image: lambda.Runtime.PYTHON_3_12.bundlingImage,
          local: {
            tryBundle(outputDir: string): boolean {
              try {
                execFileSync('python', ['-m', 'pip', 'install', '.', '-t', outputDir], {
                  cwd: mediaEventProcessorSourcePath,
                  stdio: 'inherit',
                });
                copyFileSync(
                  path.join(mediaEventProcessorSourcePath, 'app.py'),
                  path.join(outputDir, 'app.py'),
                );
                return true;
              } catch {
                return false;
              }
            },
          },
          command: ['bash', '-c', 'pip install . -t /asset-output && cp app.py /asset-output/'],
        },
      }),
      handler: 'app.handler',
      timeout: cdk.Duration.seconds(envConfig.eventProcessorTimeoutSec),
      memorySize: envConfig.eventProcessorMemoryMiB,
      vpc,
      vpcSubnets: { subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS },
      securityGroups: [mediaEventProcessorSg],
      environment: {
        APP_ENV: envName,
        ENABLE_MEDIA_PROCESSING: String(envConfig.enableMediaProcessing),
        EVENT_QUEUE_NAME: this.mediaQueue.queueName,
        EVENT_DLQ_MAX_RECEIVE_COUNT: String(envConfig.eventDlqMaxReceiveCount),
        DB_SECRET_ARN: auroraSecret.secretArn,
        VIDEO_BUCKET_NAME: mediaBucket.bucketName,
        VIDEO_UPLOAD_PREFIX: envConfig.videoUploadPrefix,
        MEDIA_OUTPUT_PREFIX: envConfig.mediaOutputPrefix,
        VPC_ID: vpc.vpcId,
        MEDIACONVERT_ROLE_ARN: mediaConvertJobRole.roleArn,
      },
    });

    this.mediaEventProcessor.addEventSource(
      new lambdaEventSources.SqsEventSource(this.mediaQueue, {
        enabled: envConfig.enableMediaProcessing,
      }),
    );

    // ────────────────────────────────────────────────
    // 実行時アクセス権限
    // media 処理に必要な Aurora Secret / S3 / SQS / MediaConvert のみに権限を付与する
    // ────────────────────────────────────────────────
    auroraSecret.grantRead(this.mediaEventProcessor);
    mediaBucket.grantRead(this.mediaEventProcessor, `${envConfig.videoUploadPrefix}*`);
    mediaBucket.grantWrite(this.mediaEventProcessor, `${envConfig.mediaOutputPrefix}*`);

    this.mediaEventProcessor.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'MediaEventProcessorLogsWrite',
        effect: iam.Effect.ALLOW,
        actions: ['logs:CreateLogStream', 'logs:PutLogEvents'],
        resources: [`${logGroup.logGroupArn}:*`],
      }),
    );

    this.mediaEventProcessor.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'MediaQueueConsume',
        effect: iam.Effect.ALLOW,
        actions: [
          'sqs:ReceiveMessage',
          'sqs:DeleteMessage',
          'sqs:GetQueueAttributes',
          'sqs:ChangeMessageVisibility',
        ],
        resources: [this.mediaQueue.queueArn],
      }),
    );

    this.mediaEventProcessor.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'MediaConvertDescribeEndpoints',
        effect: iam.Effect.ALLOW,
        actions: ['mediaconvert:DescribeEndpoints'],
        resources: ['*'],
      }),
    );

    this.mediaEventProcessor.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'MediaConvertCreateJob',
        effect: iam.Effect.ALLOW,
        actions: ['mediaconvert:CreateJob'],
        resources: [
          cdk.Stack.of(this).formatArn({
            service: 'mediaconvert',
            resource: 'queues',
            resourceName: 'Default',
            arnFormat: cdk.ArnFormat.SLASH_RESOURCE_NAME,
          }),
        ],
      }),
    );

    this.mediaEventProcessor.addToRolePolicy(
      new iam.PolicyStatement({
        sid: 'MediaConvertPassRole',
        effect: iam.Effect.ALLOW,
        actions: ['iam:PassRole'],
        resources: [mediaConvertJobRole.roleArn],
        conditions: {
          StringEquals: {
            'iam:PassedToService': 'mediaconvert.amazonaws.com',
          },
        },
      }),
    );

    // ────────────────────────────────────────────────
    // Media 処理監視
    // Queue 滞留、EventBridge 配送失敗、Lambda エラーを同じ Stack で検知する
    // ────────────────────────────────────────────────
    new cloudwatch.Alarm(this, 'MediaDlqVisibleMessagesAlarm', {
      alarmName: buildResourceName(envName, 'media-dlq-visible-messages'),
      metric: this.mediaDlq.metricApproximateNumberOfMessagesVisible({
        period: cdk.Duration.minutes(5),
        statistic: 'maximum',
      }),
      threshold: 1,
      comparisonOperator: cloudwatch.ComparisonOperator.GREATER_THAN_OR_EQUAL_TO_THRESHOLD,
      evaluationPeriods: 1,
      datapointsToAlarm: 1,
    });

    new cloudwatch.Alarm(this, 'MediaConvertStatusRuleFailedInvocationsAlarm', {
      alarmName: buildResourceName(
        envName,
        'media-processing-mediaconvert-status-rule-failed-invocations',
      ),
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

    new cloudwatch.Alarm(this, 'MediaEventProcessorErrorsAlarm', {
      alarmName: buildResourceName(envName, 'media-event-processor-errors'),
      metric: this.mediaEventProcessor.metricErrors({
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
