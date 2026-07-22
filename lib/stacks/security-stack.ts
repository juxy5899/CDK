import * as cdk from 'aws-cdk-lib';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as cloudtrail from 'aws-cdk-lib/aws-cloudtrail';
import * as s3 from 'aws-cdk-lib/aws-s3';
import * as logs from 'aws-cdk-lib/aws-logs';
import * as guardduty from 'aws-cdk-lib/aws-guardduty';
import * as securityhub from 'aws-cdk-lib/aws-securityhub';
import { Construct } from 'constructs';
import { EnvConfig, buildResourceName, isPlaceholder } from '../config/env-config';

export interface SecurityStackProps extends cdk.StackProps {
  envName: string;
  envConfig: EnvConfig;
}

export class SecurityStack extends cdk.Stack {
  /** 顧客 AWS アカウントから行動ログ Delivery TSV を取得するためのクロスアカウントロール */
  public readonly actionLogDeliveryAccessRole?: iam.Role;

  constructor(scope: Construct, id: string, props: SecurityStackProps) {
    super(scope, id, props);

    const { envName, envConfig } = props;

    // ============================================================
    // 行動ログ Delivery TSV 取得用クロスアカウント IAM ロール
    // dev 環境では顧客向け権限を作成しない
    // ============================================================
    if (envName !== 'dev') {
      const customerAccountId = envConfig.actionLogDeliveryCustomerAccountId;
      const externalId = envConfig.actionLogDeliveryExternalId;

      if (!customerAccountId || !externalId) {
        throw new Error(
          'actionLogDeliveryCustomerAccountId と actionLogDeliveryExternalId を設定してください',
        );
      }

      // placeholder の場合は既定の顧客アカウントを使い、環境設定確定後は明示 ID に置き換える
      const customerAccountPrincipal = isPlaceholder(customerAccountId)
        ? new iam.AccountPrincipal('825269749877') // 部署先 AWS アカウント ID
        : new iam.AccountPrincipal(customerAccountId);

      this.actionLogDeliveryAccessRole = new iam.Role(this, 'ActionLogDeliveryAccessRole', {
        roleName: buildResourceName(envName, 'action-log-delivery-access-role'),
        assumedBy: customerAccountPrincipal.withConditions({
          StringEquals: {
            'sts:ExternalId': externalId,
          },
        }),
        description:
          'Cross-account IAM role for retrieving action log delivery TSV files from the customer AWS account',
      });

      // バケット一覧権限は Delivery TSV の prefix のみに限定し、他 prefix の存在を見せない
      this.actionLogDeliveryAccessRole.addToPolicy(
        new iam.PolicyStatement({
          sid: 'ListActionLogDeliveryBucket',
          effect: iam.Effect.ALLOW,
          actions: ['s3:ListBucket'],
          resources: [`arn:aws:s3:::${envConfig.actionLogDeliveryBucketName}`],
          conditions: {
            StringLike: {
              's3:prefix': [
                envConfig.actionLogDeliveryEventsPrefix,
                `${envConfig.actionLogDeliveryEventsPrefix}*`,
                envConfig.actionLogDeliveryAttributesPrefix,
                `${envConfig.actionLogDeliveryAttributesPrefix}*`,
              ],
            },
          },
        }),
      );

      // オブジェクト取得も events / attributes の TSV 出力 prefix に限定する
      this.actionLogDeliveryAccessRole.addToPolicy(
        new iam.PolicyStatement({
          sid: 'GetActionLogDeliveryObjects',
          effect: iam.Effect.ALLOW,
          actions: ['s3:GetObject'],
          resources: [
            `arn:aws:s3:::${envConfig.actionLogDeliveryBucketName}/${envConfig.actionLogDeliveryEventsPrefix}*`,
            `arn:aws:s3:::${envConfig.actionLogDeliveryBucketName}/${envConfig.actionLogDeliveryAttributesPrefix}*`,
          ],
        }),
      );
    }

    // ============================================================
    // CloudTrail（全 API 操作の記録）
    // enableCloudTrail フラグが true の場合のみ作成
    // ============================================================
    if (envConfig.enableCloudTrail) {
      // CloudTrail ログ保存用 S3 バケット
      const trailBucket = new s3.Bucket(this, 'TrailBucket', {
        bucketName: envConfig.cloudTrailBucketName,
        encryption: s3.BucketEncryption.S3_MANAGED,
        blockPublicAccess: s3.BlockPublicAccess.BLOCK_ALL,
        versioned: false,
        removalPolicy: cdk.RemovalPolicy.RETAIN,
        lifecycleRules: [
          {
            // CloudTrail ログを 90 日後に S3 Glacier Flexible Retrieval へ移行（コスト最適化）
            transitions: [
              {
                storageClass: s3.StorageClass.GLACIER,
                transitionAfter: cdk.Duration.days(90),
              },
            ],
          },
        ],
      });

      // CloudTrail: 全 API 操作の記録
      new cloudtrail.Trail(this, 'Trail', {
        trailName: buildResourceName(envName, 'trail'),
        bucket: trailBucket,
        includeGlobalServiceEvents: true,
        isMultiRegionTrail: false,
        enableFileValidation: true,
        sendToCloudWatchLogs: true,
        cloudWatchLogsRetention: logs.RetentionDays.THREE_MONTHS,
      });
    }

    // ============================================================
    // GuardDuty 脅威検知ディテクター
    // enableGuardDuty フラグが true の場合のみ作成
    // ============================================================
    if (envConfig.enableGuardDuty) {
      new guardduty.CfnDetector(this, 'GuardDutyDetector', {
        enable: true,
        findingPublishingFrequency: 'SIX_HOURS',
        // S3 ログ解析の有効化
        dataSources: {
          s3Logs: { enable: true },
        },
      });
    }

    // ============================================================
    // Security Hub（セキュリティ標準の自動チェック）
    // enableSecurityHub フラグが true の場合のみ作成
    // 注意: Security Hub の標準チェックには AWS Config の有効化が必要（初回デプロイ時にエラーになる場合あり）
    // ============================================================
    if (envConfig.enableSecurityHub) {
      new securityhub.CfnHub(this, 'SecurityHub', {
        tags: {
          Name: buildResourceName(envName, 'security-hub'),
        },
      });
    }

    // ============================================================
    // Amazon Inspector（ECR/EC2/Lambda の脆弱性スキャン）
    // enableInspector フラグが true の場合のみ有効化
    // ============================================================
    if (envConfig.enableInspector) {
      new cdk.CfnResource(this, 'InspectorEnabler', {
        type: 'AWS::InspectorV2::Enabler',
        properties: {
          ResourceTypes: ['ECR', 'EC2', 'LAMBDA'],
        },
      });
    }
  }
}
