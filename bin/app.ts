#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from '../lib/stacks/network-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { ComputeStack } from '../lib/stacks/compute-stack';
import { SecurityStack } from '../lib/stacks/security-stack';
import { MediaProcessingStack } from '../lib/stacks/media-processing-stack';
import { EdgeStack } from '../lib/stacks/edge-stack';
import { environments } from '../lib/config/environments';

const app = new cdk.App();

// コンテキストから環境名を取得（デフォルトは dev）
// 使用例: cdk synth -c env=dev | cdk synth -c env=stg | cdk synth -c env=prod
const envName = (app.node.tryGetContext('env') as string) ?? 'dev';
const baseEnvConfig = environments[envName];

if (!baseEnvConfig) {
  throw new Error(`環境 "${envName}" の設定が見つかりません。有効な値: dev, stg, prod`);
}

const originVerifyHeaderValue = app.node.tryGetContext('originVerifyHeaderValue') as
  string | undefined;
const envConfig =
  originVerifyHeaderValue === undefined
    ? baseEnvConfig
    : {
        ...baseEnvConfig,
        cloudFrontOriginVerifyHeaderValue: originVerifyHeaderValue,
      };
const appApiImageTag =
  (app.node.tryGetContext('appApiImageTag') as string | undefined) ??
  (envName === 'dev' ? 'latest' : 'PLACEHOLDER_APP_API_IMAGE_TAG');
const mgtApiImageTag =
  (app.node.tryGetContext('mgtApiImageTag') as string | undefined) ??
  (envName === 'dev' ? 'latest' : 'PLACEHOLDER_MGT_API_IMAGE_TAG');
const strictComputeValidation = app.node.tryGetContext('strictComputeValidation') === 'true';

// 共通スタックプロパティ
const env: cdk.Environment = {
  account: envConfig.account,
  region: envConfig.region,
};

// 全リソースに付与する共通タグ
cdk.Tags.of(app).add('Project', 'MTI-AsahimyappSystem');
cdk.Tags.of(app).add('Environment', envName);
cdk.Tags.of(app).add('ManagedBy', 'CDK');

// ネットワークスタック（全スタックの基盤）
const networkStack = new NetworkStack(app, `MTI-${envName}-NetworkStack`, {
  env,
  envName,
  envConfig,
  description: `[${envName}] MTI Asahimyapp System - Network Foundation Stack`,
  terminationProtection: envName === 'prod',
});

// セキュリティスタック（NetworkStack に依存）
const securityStack = new SecurityStack(app, `MTI-${envName}-SecurityStack`, {
  env,
  envName,
  envConfig,
  description: `[${envName}] MTI Asahimyapp System - Security Foundation Stack`,
  terminationProtection: envName === 'prod',
});
securityStack.addDependency(networkStack);

// データスタック（NetworkStack + SecurityStack に依存）
const dataStack = new DataStack(app, `MTI-${envName}-DataStack`, {
  env,
  envName,
  envConfig,
  vpc: networkStack.vpc,
  description: `[${envName}] MTI Asahimyapp System - Data Foundation Stack`,
  terminationProtection: envName === 'prod',
});
dataStack.addDependency(networkStack);
dataStack.addDependency(securityStack);

// Media 処理スタック（NetworkStack + DataStack に依存）
const mediaProcessingStack = new MediaProcessingStack(app, `MTI-${envName}-MediaProcessingStack`, {
  env,
  envName,
  envConfig,
  vpc: networkStack.vpc,
  mediaBucket: dataStack.mediaBucket,
  auroraSecret: dataStack.auroraSecret,
  auroraSecurityGroup: dataStack.auroraSecurityGroup,
  description: `[${envName}] MTI Asahimyapp System - Media Processing Stack`,
  terminationProtection: envName === 'prod',
});
mediaProcessingStack.addDependency(networkStack);
mediaProcessingStack.addDependency(dataStack);

// コンピュートスタック（NetworkStack + DataStack + MediaProcessingStack に依存）
const computeStack = new ComputeStack(app, `MTI-${envName}-ComputeStack`, {
  env,
  envName,
  envConfig,
  vpc: networkStack.vpc,
  appApiRepository: dataStack.appApiRepository,
  mgtApiRepository: dataStack.mgtApiRepository,
  mediaBucket: dataStack.mediaBucket,
  actionLogRawBucket: dataStack.actionLogRawBucket,
  accessLogBucket: dataStack.accessLogBucket,
  appApiImageTag,
  mgtApiImageTag,
  strictValidation: strictComputeValidation,
  auroraSecret: dataStack.auroraSecret,
  auroraSecurityGroup: dataStack.auroraSecurityGroup,
  eventQueue: mediaProcessingStack.mediaQueue,
  description: `[${envName}] MTI Asahimyapp System - Compute Foundation Stack`,
  terminationProtection: envName === 'prod',
});
computeStack.addDependency(networkStack);
computeStack.addDependency(dataStack);
computeStack.addDependency(mediaProcessingStack);

// エッジスタック（CloudFront/WAF/ACM）
// CloudFront スコープの WAF と証明書を扱うため us-east-1 に固定する
const edgeStack = new EdgeStack(app, `MTI-${envName}-EdgeStack`, {
  env: {
    account: envConfig.account,
    region: envConfig.edgeRegion,
  },
  envName,
  envConfig,
  albOriginDomainName: computeStack.alb.loadBalancerDnsName,
  strictValidation: strictComputeValidation,
  description: `[${envName}] MTI Asahimyapp System - Edge Delivery Foundation Stack`,
  terminationProtection: envName === 'prod',
});
edgeStack.addDependency(computeStack);
