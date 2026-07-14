import * as cdk from 'aws-cdk-lib';
import * as kms from 'aws-cdk-lib/aws-kms';
import * as iam from 'aws-cdk-lib/aws-iam';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import * as wafv2 from 'aws-cdk-lib/aws-wafv2';
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
  vpc: ec2.IVpc;
}

export class SecurityStack extends cdk.Stack {
  /** データベース・シークレット等の暗号化に使用する KMS カスタマーマネージドキー */
  public readonly cmk: kms.Key;

  /** 外部 AWS アカウントの Cognito からの認証フェデレーション用クロスアカウントロール */
  public readonly cognitoCrossAccountRole: iam.Role;

  /** WAF WebACL ARN（WAF 無効時は undefined） */
  public readonly webAclArn: string | undefined;

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
    // WAF v2 WebACL（REGIONAL スコープ、ALB にアタッチ）
    // enableWaf フラグが true の場合のみ作成
    // ============================================================
    if (envConfig.enableWaf) {
      // CIDRs が空の場合はプレースホルダー値を使用
      const jpkiCidrs =
        envConfig.jpkiAllowedCidrs.length > 0
          ? envConfig.jpkiAllowedCidrs
          : ['0.0.0.0/32']; // PLACEHOLDER: 実際の JPKI サーバー CIDR に要更新

      // JPKI IP セット（REGIONAL スコープ）
      const jpkiIpSet = new wafv2.CfnIPSet(this, 'JpkiIpSet', {
        name: buildResourceName(envName, 'jpki-ip-set'),
        scope: 'REGIONAL',
        ipAddressVersion: 'IPV4',
        addresses: jpkiCidrs,
        description: 'JPKI 認証サーバーの許可 IP リスト',
      });

      // WAF WebACL（REGIONAL: ALB アタッチ用）
      const webAcl = new wafv2.CfnWebACL(this, 'WebAcl', {
        name: buildResourceName(envName, 'web-acl'),
        scope: 'REGIONAL',
        // デフォルト動作: 許可（マネージドルールでブロック）
        // TODO: 現在は厳密な JPKI allowlist ではない。
        // TODO: JPKI のみを許可する要件が確定したら defaultAction を block に変更し、
        // TODO: 対象パスまたは入口ごとの allowlist 設計へ切り替える。
        defaultAction: { allow: {} },
        visibilityConfig: {
          cloudWatchMetricsEnabled: true,
          metricName: buildResourceName(envName, 'web-acl-metric'),
          sampledRequestsEnabled: true,
        },
        rules: [
          // ルール 1: JPKI IP セットからのアクセスを明示的に許可（高優先度）
          {
            name: 'AllowJpkiIpSet',
            priority: 1,
            action: { allow: {} },
            statement: {
              ipSetReferenceStatement: {
                arn: jpkiIpSet.attrArn,
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: 'AllowJpkiIpSet',
              sampledRequestsEnabled: true,
            },
          },
          // ルール 2: AWS マネージドルール共通ルールセット（悪意あるリクエストをブロック）
          {
            name: 'AWSManagedRulesCommonRuleSet',
            priority: 10,
            overrideAction: { none: {} },
            statement: {
              managedRuleGroupStatement: {
                vendorName: 'AWS',
                name: 'AWSManagedRulesCommonRuleSet',
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: 'AWSManagedRulesCommonRuleSet',
              sampledRequestsEnabled: true,
            },
          },
          // ルール 3: AWS マネージドルール既知の不正入力（SQL インジェクション等）
          {
            name: 'AWSManagedRulesKnownBadInputsRuleSet',
            priority: 20,
            overrideAction: { none: {} },
            statement: {
              managedRuleGroupStatement: {
                vendorName: 'AWS',
                name: 'AWSManagedRulesKnownBadInputsRuleSet',
              },
            },
            visibilityConfig: {
              cloudWatchMetricsEnabled: true,
              metricName: 'AWSManagedRulesKnownBadInputsRuleSet',
              sampledRequestsEnabled: true,
            },
          },
        ],
      });

      this.webAclArn = webAcl.attrArn;
    } else {
      this.webAclArn = undefined;
    }

    // ============================================================
    // CloudTrail（全 API 操作の記録）
    // enableCloudTrail フラグが true の場合のみ作成
    // ============================================================
    if (envConfig.enableCloudTrail) {
      // CloudTrail ログ保存用 S3 バケット
      const trailBucket = new s3.Bucket(this, 'TrailBucket', {
        bucketName: cdk.PhysicalName.GENERATE_IF_NEEDED,
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
    // ACM 証明書 — Phase 5 で実装予定
    // ============================================================
    // 以下のリソースは未確定パラメータが確定次第 Phase 5 で追加する:
    //   1. aws-cdk-lib/aws-certificatemanager の Certificate
    //      → envConfig.domainName と envConfig.certificateArn が確定したら参照する
    //   2. Route 53 HostedZone の参照
    // ============================================================

    // ============================================================
    // Inspector — Phase 5 で実装予定
    // ============================================================
  }
}
