#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from 'aws-cdk-lib';
import { NetworkStack } from '../lib/stacks/network-stack';
import { DataStack } from '../lib/stacks/data-stack';
import { ComputeStack } from '../lib/stacks/compute-stack';
import { SecurityStack } from '../lib/stacks/security-stack';
import { EventProcessingStack } from '../lib/stacks/event-processing-stack';
import { environments } from '../lib/config/environments';

const app = new cdk.App();

// コンテキストから環境名を取得（デフォルトは dev）
// 使用例: cdk synth -c env=dev | cdk synth -c env=stg | cdk synth -c env=prod
const envName = (app.node.tryGetContext('env') as string) ?? 'dev';
const envConfig = environments[envName];

if (!envConfig) {
  throw new Error(`環境 "${envName}" の設定が見つかりません。有効な値: dev, stg, prod`);
}

// 共通スタックプロパティ
const env: cdk.Environment = {
  account: envConfig.account,
  region: envConfig.region,
};

// 全リソースに付与する共通タグ
cdk.Tags.of(app).add('Project', 'MTI-VideoSystem');
cdk.Tags.of(app).add('Environment', envName);
cdk.Tags.of(app).add('ManagedBy', 'CDK');

// ネットワークスタック（全スタックの基盤）
const networkStack = new NetworkStack(app, `MTI-${envName}-NetworkStack`, {
  env,
  envName,
  envConfig,
  description: `[${envName}] MTI ビデオシステム - ネットワーク基盤スタック`,
  terminationProtection: envName === 'prod',
});

// データスタック（NetworkStack に依存）
const dataStack = new DataStack(app, `MTI-${envName}-DataStack`, {
  env,
  envName,
  envConfig,
  vpc: networkStack.vpc,
  description: `[${envName}] MTI ビデオシステム - データ基盤スタック`,
  terminationProtection: envName === 'prod',
});
dataStack.addDependency(networkStack);

// セキュリティスタック（NetworkStack に依存）
const securityStack = new SecurityStack(app, `MTI-${envName}-SecurityStack`, {
  env,
  envName,
  envConfig,
  vpc: networkStack.vpc,
  description: `[${envName}] MTI ビデオシステム - セキュリティ基盤スタック`,
  terminationProtection: envName === 'prod',
});
securityStack.addDependency(networkStack);

// コンピュートスタック（NetworkStack + DataStack に依存）
const computeStack = new ComputeStack(app, `MTI-${envName}-ComputeStack`, {
  env,
  envName,
  envConfig,
  vpc: networkStack.vpc,
  appRepository: dataStack.appRepository,
  auroraSecret: dataStack.auroraSecret,
  webAclArn: securityStack.webAclArn,   // WAF ARN（無効時は undefined）
  description: `[${envName}] MTI ビデオシステム - 計算基盤スタック`,
  terminationProtection: envName === 'prod',
});
computeStack.addDependency(networkStack);
computeStack.addDependency(dataStack);
// ComputeStack は SecurityStack にも依存（KMS キーを将来使用するため）
computeStack.addDependency(securityStack);

// イベント処理スタック（NetworkStack + DataStack + ComputeStack に依存）
const eventProcessingStack = new EventProcessingStack(app, `MTI-${envName}-EventProcessingStack`, {
  env,
  envName,
  envConfig,
  vpc: networkStack.vpc,
  videoBucket: dataStack.videoBucket,
  description: `[${envName}] MTI ビデオシステム - イベント処理基盤スタック`,
  terminationProtection: envName === 'prod',
});
eventProcessingStack.addDependency(networkStack);
eventProcessingStack.addDependency(dataStack);
eventProcessingStack.addDependency(computeStack);
