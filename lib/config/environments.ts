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
    account: process.env.CDK_DEPLOY_ACCOUNT ?? process.env.CDK_DEFAULT_ACCOUNT ?? '123456789012',
    region: 'ap-northeast-1',
    vpcEndpointsEnabled: false,
    dbInstanceClass: 'db.t4g.large',
    auroraMultiAz: false,
    taskCpu: 256,
    taskMemoryMiB: 512,
    minTaskCount: 1,
    maxTaskCount: 2,
    domainName: 'PLACEHOLDER_DOMAIN_NAME',
    certificateArn: 'PLACEHOLDER_CERTIFICATE_ARN',
    wafJpkiIpSetArn: 'PLACEHOLDER_WAF_JPKI_IP_SET_ARN',
    externalCognitoAccountId: 'PLACEHOLDER_EXTERNAL_COGNITO_ACCOUNT_ID',
    enableWaf: false,
    jpkiAllowedCidrs: [],            // dev は WAF 無効のため空
    enableCloudTrail: false,
    enableGuardDuty: false,
    enableSecurityHub: false,
    enableEventProcessing: true,
    eventBusName: '',
    videoUploadPrefix: 'uploads/',
    mediaOutputPrefix: 'processed/',
    mediaConvertEndpoint: 'PLACEHOLDER_MEDIACONVERT_ENDPOINT',
    mediaConvertRoleArn: 'PLACEHOLDER_MEDIACONVERT_ROLE_ARN',
    pushApplicationId: 'PLACEHOLDER_PUSH_APPLICATION_ID',
    pushCredentialsSecretArn: 'PLACEHOLDER_PUSH_CREDENTIALS_SECRET_ARN',
    eventProcessorTimeoutSec: 30,
    eventProcessorMemoryMiB: 256,
    eventQueueVisibilityTimeoutSec: 120,
    eventQueueRetentionDays: 4,
    eventDlqMaxReceiveCount: 3,
  },

  // ────────────────────────────────────────────────
  // ステージング環境（本番に近い構成）
  // ────────────────────────────────────────────────
  stg: {
    account: process.env.CDK_DEPLOY_ACCOUNT ?? process.env.CDK_DEFAULT_ACCOUNT ?? '123456789012',
    region: 'ap-northeast-1',
    vpcEndpointsEnabled: true,
    dbInstanceClass: 'db.t4g.large',
    auroraMultiAz: true,
    taskCpu: 512,
    taskMemoryMiB: 1024,
    minTaskCount: 2,
    maxTaskCount: 3,
    domainName: 'PLACEHOLDER_DOMAIN_NAME',
    certificateArn: 'PLACEHOLDER_CERTIFICATE_ARN',
    wafJpkiIpSetArn: 'PLACEHOLDER_WAF_JPKI_IP_SET_ARN',
    externalCognitoAccountId: 'PLACEHOLDER_EXTERNAL_COGNITO_ACCOUNT_ID',
    enableWaf: true,
    jpkiAllowedCidrs: ['0.0.0.0/32'],  // PLACEHOLDER: 実際の JPKI CIDR に要更新
    enableCloudTrail: true,
    enableGuardDuty: true,
    enableSecurityHub: false,           // stg はコスト削減のため無効
    enableEventProcessing: true,
    eventBusName: '',
    videoUploadPrefix: 'uploads/',
    mediaOutputPrefix: 'processed/',
    mediaConvertEndpoint: 'PLACEHOLDER_MEDIACONVERT_ENDPOINT',
    mediaConvertRoleArn: 'PLACEHOLDER_MEDIACONVERT_ROLE_ARN',
    pushApplicationId: 'PLACEHOLDER_PUSH_APPLICATION_ID',
    pushCredentialsSecretArn: 'PLACEHOLDER_PUSH_CREDENTIALS_SECRET_ARN',
    eventProcessorTimeoutSec: 60,
    eventProcessorMemoryMiB: 512,
    eventQueueVisibilityTimeoutSec: 180,
    eventQueueRetentionDays: 14,
    eventDlqMaxReceiveCount: 5,
  },

  // ────────────────────────────────────────────────
  // 本番環境（高可用性・高信頼性構成）
  // ────────────────────────────────────────────────
  prod: {
    account: process.env.CDK_DEPLOY_ACCOUNT ?? process.env.CDK_DEFAULT_ACCOUNT ?? '123456789012',
    region: 'ap-northeast-1',
    vpcEndpointsEnabled: true,
    dbInstanceClass: 'db.t4g.large',
    auroraMultiAz: true,
    taskCpu: 512,
    taskMemoryMiB: 1024,
    minTaskCount: 2,
    maxTaskCount: 3,
    domainName: 'PLACEHOLDER_DOMAIN_NAME',
    certificateArn: 'PLACEHOLDER_CERTIFICATE_ARN',
    wafJpkiIpSetArn: 'PLACEHOLDER_WAF_JPKI_IP_SET_ARN',
    externalCognitoAccountId: 'PLACEHOLDER_EXTERNAL_COGNITO_ACCOUNT_ID',
    enableWaf: true,
    jpkiAllowedCidrs: ['0.0.0.0/32'],  // PLACEHOLDER: 実際の JPKI CIDR に要更新
    enableCloudTrail: true,
    enableGuardDuty: true,
    enableSecurityHub: true,
    enableEventProcessing: true,
    eventBusName: '',
    videoUploadPrefix: 'uploads/',
    mediaOutputPrefix: 'processed/',
    mediaConvertEndpoint: 'PLACEHOLDER_MEDIACONVERT_ENDPOINT',
    mediaConvertRoleArn: 'PLACEHOLDER_MEDIACONVERT_ROLE_ARN',
    pushApplicationId: 'PLACEHOLDER_PUSH_APPLICATION_ID',
    pushCredentialsSecretArn: 'PLACEHOLDER_PUSH_CREDENTIALS_SECRET_ARN',
    eventProcessorTimeoutSec: 60,
    eventProcessorMemoryMiB: 512,
    eventQueueVisibilityTimeoutSec: 180,
    eventQueueRetentionDays: 14,
    eventDlqMaxReceiveCount: 5,
  },
};
