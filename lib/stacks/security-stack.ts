import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
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
  /** データベース・シークレット等の暗号化に使用する KMS カスタマーマネージドキー */
  public readonly cmk: kms.Key;

  /** 外部 AWS アカウントの Cognito からの認証フェデレーション用クロスアカウントロール */
  public readonly cognitoCrossAccountRole: iam.Role;

  constructor(scope: Construct, id: string, props: SecurityStackProps) {
    super(scope, id, props);

    const { envName, envConfig } = props;

    // ============================================================
    // KMS カスタマーマネージドキー
    // ============================================================
    this.cmk = new kms.Key(this, 'Cmk', {
      description: buildResourceName(envName, 'cmk'),
      enableKeyRotation: true,
      removalPolicy: cdk.RemovalPolicy.RETAIN,
    });

    // ============================================================
    // クロスアカウント IAM ロール（Cognito フェデレーション用）
    // ============================================================
    // envConfig.externalCognitoAccountId がプレースホルダーの場合も synth できるよう
    // iam.AccountPrincipal でダミー 12 桁アカウント ID を使用する
    const externalAccountPrincipal = isPlaceholder(envConfig.externalCognitoAccountId)
      ? new iam.AccountPrincipal('123456789012') // プレースホルダー: 実際の外部アカウント ID に要更新
      : new iam.AccountPrincipal(envConfig.externalCognitoAccountId);

    this.cognitoCrossAccountRole = new iam.Role(this, 'CognitoCrossAccountRole', {
      roleName: buildResourceName(envName, 'cognito-cross-account-role'),
      assumedBy: externalAccountPrincipal,
      description: '外部 Cognito アカウントからのアクセスを許可するクロスアカウント IAM ロール',
      // TODO: Phase 5 で permissionsBoundary を追加予定
      // permissionsBoundary: iam.ManagedPolicy.fromManagedPolicyArn(this, 'PermBoundary', envConfig.crossAccountRolePermissionBoundaryArn),
    });

    // スタブポリシー（Phase 5 で詳細権限に置き換え予定）
    this.cognitoCrossAccountRole.addToPolicy(
      new iam.PolicyStatement({
        sid: 'PlaceholderAssumeRoleStub',
        effect: iam.Effect.ALLOW,
        actions: ['sts:AssumeRole'],
        resources: [this.cognitoCrossAccountRole.roleArn],
      }),
    );

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
            // CloudTrail ログを 90 日後に Glacier に移行（コスト最適化）
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
    // 注意: Security Hub は事前に有効化が必要（初回デプロイ時にエラーになる場合あり）
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
