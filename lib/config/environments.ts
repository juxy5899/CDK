import { EnvConfig } from './env-config';

/**
 * 各環境の設定定義
 * CDK_DEPLOY_ACCOUNT 環境変数が未設定の場合は CDK_DEFAULT_ACCOUNT を使用し、
 * それも未設定の場合はプレースホルダー値を使用する
 */
export const environments: Record<string, EnvConfig> = {
  // ────────────────────────────────────────────────
  // 開発環境（コスト最小構成）
  // ────────────────────────────────────────────────
  dev: {
    // ============================================================
    // よく変更する項目
    // ============================================================
    account: process.env.CDK_DEPLOY_ACCOUNT ?? process.env.CDK_DEFAULT_ACCOUNT ?? '825269749877', // 部署先 AWS アカウント ID
    region: 'ap-northeast-1', // メインのデプロイリージョン
    taskCpu: 256, // ECS Fargate タスク CPU
    taskMemoryMiB: 512, // ECS Fargate タスクメモリ（MiB）
    minTaskCount: 1, // ECS サービス最小タスク数
    maxTaskCount: 2, // ECS サービス最大タスク数
    enableBackup: false, // AWS Backup 有効化フラグ
    enableAthena: false, // Athena（ログ分析基盤）有効化フラグ
    enableInspector: false, // Inspector（脆弱性スキャン）有効化フラグ
    enableXray: true, // X-Ray（分散トレーシング）有効化フラグ
    enableEventProcessing: true, // EventBridge/SQS/Lambda のイベント処理基盤有効化フラグ
    videoUploadPrefix: 'uploads/', // 動画アップロード入力プレフィックス
    mediaOutputPrefix: 'processed/', // MediaConvert 出力プレフィックス
    edgeRegion: 'us-east-1', // EdgeStack デプロイ先リージョン（CloudFront/WAF/ACM 必須）
    edgeDomainName: 'PLACEHOLDER_EDGE_DOMAIN_NAME', // CloudFront カスタムドメイン名
    edgeCertificateArn: 'PLACEHOLDER_EDGE_CERTIFICATE_ARN', // us-east-1 の ACM 証明書 ARN
    albOriginDomainName: 'PLACEHOLDER_ALB_ORIGIN_DOMAIN_NAME', // CloudFront から中継する ALB のドメイン名
    cloudFrontOriginPrefixListId: 'pl-58a04531', // ap-northeast-1 の CloudFront Origin-Facing マネージド Prefix List ID

    // ============================================================
    // 詳細設定（通常は既定値のまま運用）
    // ============================================================
    vpcEndpointsEnabled: false, // VPC エンドポイント有効化フラグ（NAT コスト最適化と通信閉域化）
    enableFixedNatEip: false, // 固定 NAT EIP 有効化フラグ（dev は必要時のみ true）
    dbInstanceClass: 'db.t4g.large', // Aurora の DB インスタンスクラス
    auroraMultiAz: false, // Aurora リーダー追加による Multi-AZ 構成フラグ
    domainName: 'PLACEHOLDER_DOMAIN_NAME', // 既存ドメイン名（将来連携用プレースホルダー）
    certificateArn: 'PLACEHOLDER_CERTIFICATE_ARN', // 既存 ACM 証明書 ARN（将来連携用プレースホルダー）
    externalCognitoAccountId: 'PLACEHOLDER_EXTERNAL_COGNITO_ACCOUNT_ID', // 外部 Cognito 側 AWS アカウント ID
    enableWaf: false, // EdgeStack の CloudFront WAF を有効化するフラグ（dev は無効）
    enableCloudTrail: false, // CloudTrail 有効化フラグ
    enableGuardDuty: false, // GuardDuty 有効化フラグ
    enableSecurityHub: false, // Security Hub 有効化フラグ
    eventBusName: '', // EventBridge カスタムバス名（空なら自動命名）
    mediaConvertEndpoint: 'PLACEHOLDER_MEDIACONVERT_ENDPOINT', // MediaConvert エンドポイント
    mediaConvertRoleArn: 'PLACEHOLDER_MEDIACONVERT_ROLE_ARN', // MediaConvert 実行ロール ARN
    pushApplicationId: 'PLACEHOLDER_PUSH_APPLICATION_ID', // Push 配信アプリケーション ID
    pushCredentialsSecretArn: 'PLACEHOLDER_PUSH_CREDENTIALS_SECRET_ARN', // Push 資格情報の Secrets Manager ARN
    eventProcessorTimeoutSec: 30, // EventProcessor Lambda タイムアウト（秒）
    eventProcessorMemoryMiB: 256, // EventProcessor Lambda メモリ（MiB）
    eventQueueVisibilityTimeoutSec: 120, // メインキュー可視性タイムアウト（秒）
    eventQueueRetentionDays: 4, // メインキュー/DLQ メッセージ保持期間（日）
    eventDlqMaxReceiveCount: 3, // DLQ へ移送するまでの最大再試行回数
    hostedZoneName: 'PLACEHOLDER_HOSTED_ZONE_NAME', // Route 53 ホストゾーン名
    hostedZoneId: 'PLACEHOLDER_HOSTED_ZONE_ID', // Route 53 ホストゾーン ID
    adminSiteDefaultRootObject: 'index.html', // 管理画面静的サイトのデフォルトファイル
  },

  // ────────────────────────────────────────────────
  // ステージング環境（本番に近い構成）
  // ────────────────────────────────────────────────
  stg: {
    // ============================================================
    // よく変更する項目
    // ============================================================
    account: process.env.CDK_DEPLOY_ACCOUNT ?? process.env.CDK_DEFAULT_ACCOUNT ?? '123456789012', // 部署先 AWS アカウント ID
    region: 'ap-northeast-1', // メインのデプロイリージョン
    taskCpu: 512, // ECS Fargate タスク CPU
    taskMemoryMiB: 1024, // ECS Fargate タスクメモリ（MiB）
    minTaskCount: 2, // ECS サービス最小タスク数
    maxTaskCount: 3, // ECS サービス最大タスク数
    enableBackup: true, // AWS Backup 有効化フラグ
    enableAthena: true, // Athena（ログ分析基盤）有効化フラグ
    enableInspector: true, // Inspector（脆弱性スキャン）有効化フラグ
    enableXray: true, // X-Ray（分散トレーシング）有効化フラグ
    enableEventProcessing: true, // EventBridge/SQS/Lambda のイベント処理基盤有効化フラグ
    videoUploadPrefix: 'uploads/', // 動画アップロード入力プレフィックス
    mediaOutputPrefix: 'processed/', // MediaConvert 出力プレフィックス
    edgeRegion: 'us-east-1', // EdgeStack デプロイ先リージョン（CloudFront/WAF/ACM 必須）
    edgeDomainName: 'PLACEHOLDER_EDGE_DOMAIN_NAME', // CloudFront カスタムドメイン名
    edgeCertificateArn: 'PLACEHOLDER_EDGE_CERTIFICATE_ARN', // us-east-1 の ACM 証明書 ARN
    albOriginDomainName: 'PLACEHOLDER_ALB_ORIGIN_DOMAIN_NAME', // CloudFront から中継する ALB のドメイン名
    cloudFrontOriginPrefixListId: 'pl-58a04531', // ap-northeast-1 の CloudFront Origin-Facing マネージド Prefix List ID

    // ============================================================
    // 詳細設定（通常は既定値のまま運用）
    // ============================================================
    vpcEndpointsEnabled: true, // VPC エンドポイント有効化フラグ（stg は有効）
    enableFixedNatEip: true, // 固定 NAT EIP 有効化フラグ（外部連携先の送信元 IP 許可用）
    dbInstanceClass: 'db.t4g.large', // Aurora の DB インスタンスクラス
    auroraMultiAz: true, // Aurora リーダー追加による Multi-AZ 構成フラグ
    domainName: 'PLACEHOLDER_DOMAIN_NAME', // 既存ドメイン名（将来連携用プレースホルダー）
    certificateArn: 'PLACEHOLDER_CERTIFICATE_ARN', // 既存 ACM 証明書 ARN（将来連携用プレースホルダー）
    externalCognitoAccountId: 'PLACEHOLDER_EXTERNAL_COGNITO_ACCOUNT_ID', // 外部 Cognito 側 AWS アカウント ID
    enableWaf: true, // EdgeStack の CloudFront WAF を有効化するフラグ（stg は有効）
    enableCloudTrail: true, // CloudTrail 有効化フラグ
    enableGuardDuty: true, // GuardDuty 有効化フラグ
    enableSecurityHub: false, // Security Hub 有効化フラグ（stg はコスト最適化で無効）
    eventBusName: '', // EventBridge カスタムバス名（空なら自動命名）
    mediaConvertEndpoint: 'PLACEHOLDER_MEDIACONVERT_ENDPOINT', // MediaConvert エンドポイント
    mediaConvertRoleArn: 'PLACEHOLDER_MEDIACONVERT_ROLE_ARN', // MediaConvert 実行ロール ARN
    pushApplicationId: 'PLACEHOLDER_PUSH_APPLICATION_ID', // Push 配信アプリケーション ID
    pushCredentialsSecretArn: 'PLACEHOLDER_PUSH_CREDENTIALS_SECRET_ARN', // Push 資格情報の Secrets Manager ARN
    eventProcessorTimeoutSec: 60, // EventProcessor Lambda タイムアウト（秒）
    eventProcessorMemoryMiB: 512, // EventProcessor Lambda メモリ（MiB）
    eventQueueVisibilityTimeoutSec: 180, // メインキュー可視性タイムアウト（秒）
    eventQueueRetentionDays: 14, // メインキュー/DLQ メッセージ保持期間（日）
    eventDlqMaxReceiveCount: 5, // DLQ へ移送するまでの最大再試行回数
    hostedZoneName: 'PLACEHOLDER_HOSTED_ZONE_NAME', // Route 53 ホストゾーン名
    hostedZoneId: 'PLACEHOLDER_HOSTED_ZONE_ID', // Route 53 ホストゾーン ID
    adminSiteDefaultRootObject: 'index.html', // 管理画面静的サイトのデフォルトファイル
  },

  // ────────────────────────────────────────────────
  // 本番環境（高可用性・高信頼性構成）
  // ────────────────────────────────────────────────
  prod: {
    // ============================================================
    // よく変更する項目
    // ============================================================
    account: process.env.CDK_DEPLOY_ACCOUNT ?? process.env.CDK_DEFAULT_ACCOUNT ?? '123456789012', // 部署先 AWS アカウント ID
    region: 'ap-northeast-1', // メインのデプロイリージョン
    taskCpu: 512, // ECS Fargate タスク CPU
    taskMemoryMiB: 1024, // ECS Fargate タスクメモリ（MiB）
    minTaskCount: 2, // ECS サービス最小タスク数
    maxTaskCount: 3, // ECS サービス最大タスク数
    enableBackup: true, // AWS Backup 有効化フラグ
    enableAthena: true, // Athena（ログ分析基盤）有効化フラグ
    enableInspector: true, // Inspector（脆弱性スキャン）有効化フラグ
    enableXray: true, // X-Ray（分散トレーシング）有効化フラグ
    enableEventProcessing: true, // EventBridge/SQS/Lambda のイベント処理基盤有効化フラグ
    videoUploadPrefix: 'uploads/', // 動画アップロード入力プレフィックス
    mediaOutputPrefix: 'processed/', // MediaConvert 出力プレフィックス
    edgeRegion: 'us-east-1', // EdgeStack デプロイ先リージョン（CloudFront/WAF/ACM 必須）
    edgeDomainName: 'PLACEHOLDER_EDGE_DOMAIN_NAME', // CloudFront カスタムドメイン名
    edgeCertificateArn: 'PLACEHOLDER_EDGE_CERTIFICATE_ARN', // us-east-1 の ACM 証明書 ARN
    albOriginDomainName: 'PLACEHOLDER_ALB_ORIGIN_DOMAIN_NAME', // CloudFront から中継する ALB のドメイン名
    cloudFrontOriginPrefixListId: 'pl-58a04531', // ap-northeast-1 の CloudFront Origin-Facing マネージド Prefix List ID

    // ============================================================
    // 詳細設定（通常は既定値のまま運用）
    // ============================================================
    vpcEndpointsEnabled: true, // VPC エンドポイント有効化フラグ（prod は有効）
    enableFixedNatEip: true, // 固定 NAT EIP 有効化フラグ（外部連携先の送信元 IP 許可用）
    dbInstanceClass: 'db.t4g.large', // Aurora の DB インスタンスクラス
    auroraMultiAz: true, // Aurora リーダー追加による Multi-AZ 構成フラグ
    domainName: 'PLACEHOLDER_DOMAIN_NAME', // 既存ドメイン名（将来連携用プレースホルダー）
    certificateArn: 'PLACEHOLDER_CERTIFICATE_ARN', // 既存 ACM 証明書 ARN（将来連携用プレースホルダー）
    externalCognitoAccountId: 'PLACEHOLDER_EXTERNAL_COGNITO_ACCOUNT_ID', // 外部 Cognito 側 AWS アカウント ID
    enableWaf: true, // EdgeStack の CloudFront WAF を有効化するフラグ（prod は有効）
    enableCloudTrail: true, // CloudTrail 有効化フラグ
    enableGuardDuty: true, // GuardDuty 有効化フラグ
    enableSecurityHub: true, // Security Hub 有効化フラグ
    eventBusName: '', // EventBridge カスタムバス名（空なら自動命名）
    mediaConvertEndpoint: 'PLACEHOLDER_MEDIACONVERT_ENDPOINT', // MediaConvert エンドポイント
    mediaConvertRoleArn: 'PLACEHOLDER_MEDIACONVERT_ROLE_ARN', // MediaConvert 実行ロール ARN
    pushApplicationId: 'PLACEHOLDER_PUSH_APPLICATION_ID', // Push 配信アプリケーション ID
    pushCredentialsSecretArn: 'PLACEHOLDER_PUSH_CREDENTIALS_SECRET_ARN', // Push 資格情報の Secrets Manager ARN
    eventProcessorTimeoutSec: 60, // EventProcessor Lambda タイムアウト（秒）
    eventProcessorMemoryMiB: 512, // EventProcessor Lambda メモリ（MiB）
    eventQueueVisibilityTimeoutSec: 180, // メインキュー可視性タイムアウト（秒）
    eventQueueRetentionDays: 14, // メインキュー/DLQ メッセージ保持期間（日）
    eventDlqMaxReceiveCount: 5, // DLQ へ移送するまでの最大再試行回数
    hostedZoneName: 'PLACEHOLDER_HOSTED_ZONE_NAME', // Route 53 ホストゾーン名
    hostedZoneId: 'PLACEHOLDER_HOSTED_ZONE_ID', // Route 53 ホストゾーン ID
    adminSiteDefaultRootObject: 'index.html', // 管理画面静的サイトのデフォルトファイル
  },
};
