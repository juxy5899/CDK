import * as cdk from 'aws-cdk-lib';
import * as ec2 from 'aws-cdk-lib/aws-ec2';
import { Construct } from 'constructs';
import { EnvConfig, buildResourceName } from '../config/env-config';

/**
 * ネットワークスタックのプロパティ定義
 */
export interface NetworkStackProps extends cdk.StackProps {
  /** 環境名（dev / stg / prod） */
  envName: string;
  /** 環境設定 */
  envConfig: EnvConfig;
}

/**
 * ネットワーク基盤スタック
 * VPC・サブネット・ルートテーブル・NAT Gateway・VPC Endpoint を作成する
 */
export class NetworkStack extends cdk.Stack {
  /** L2 VPC オブジェクト（他スタックから参照可能） */
  public readonly vpc: ec2.IVpc;

  /** VPC ID */
  public readonly vpcId: string;

  /** パブリックサブネット ID リスト */
  public readonly publicSubnetIds: string[];

  /** プライベートサブネット ID リスト */
  public readonly privateSubnetIds: string[];

  /** データベースサブネット ID リスト */
  public readonly dbSubnetIds: string[];

  constructor(scope: Construct, id: string, props: NetworkStackProps) {
    super(scope, id, props);

    const { envName, envConfig } = props;

    // ============================================================
    // VPC 作成（L1: 正確な CIDR 指定のため CfnVPC を使用）
    // ============================================================
    const cfnVpc = new ec2.CfnVPC(this, 'Vpc', {
      cidrBlock: '10.0.0.0/16',
      enableDnsHostnames: true,
      enableDnsSupport: true,
      tags: [{ key: 'Name', value: buildResourceName(envName, 'vpc') }],
    });

    // ============================================================
    // パブリックサブネット作成（2 AZ）
    // ============================================================

    // パブリックサブネット 1a（ap-northeast-1a）
    const publicSubnet1a = new ec2.CfnSubnet(this, 'PublicSubnet1a', {
      vpcId: cfnVpc.ref,
      cidrBlock: '10.0.1.0/24',
      availabilityZone: 'ap-northeast-1a',
      mapPublicIpOnLaunch: true,
      tags: [{ key: 'Name', value: buildResourceName(envName, 'public-subnet-1a') }],
    });

    // パブリックサブネット 1c（ap-northeast-1c）
    const publicSubnet1c = new ec2.CfnSubnet(this, 'PublicSubnet1c', {
      vpcId: cfnVpc.ref,
      cidrBlock: '10.0.2.0/24',
      availabilityZone: 'ap-northeast-1c',
      mapPublicIpOnLaunch: true,
      tags: [{ key: 'Name', value: buildResourceName(envName, 'public-subnet-1c') }],
    });

    // ============================================================
    // プライベートサブネット作成（2 AZ）
    // ============================================================

    // プライベートサブネット 1a（ap-northeast-1a）
    const privateSubnet1a = new ec2.CfnSubnet(this, 'PrivateSubnet1a', {
      vpcId: cfnVpc.ref,
      cidrBlock: '10.0.11.0/24',
      availabilityZone: 'ap-northeast-1a',
      tags: [{ key: 'Name', value: buildResourceName(envName, 'private-subnet-1a') }],
    });

    // プライベートサブネット 1c（ap-northeast-1c）
    const privateSubnet1c = new ec2.CfnSubnet(this, 'PrivateSubnet1c', {
      vpcId: cfnVpc.ref,
      cidrBlock: '10.0.12.0/24',
      availabilityZone: 'ap-northeast-1c',
      tags: [{ key: 'Name', value: buildResourceName(envName, 'private-subnet-1c') }],
    });

    // ============================================================
    // データベースサブネット作成（2 AZ、隔離サブネット）
    // ============================================================

    // データベースサブネット 1a（ap-northeast-1a）
    const dbSubnet1a = new ec2.CfnSubnet(this, 'DbSubnet1a', {
      vpcId: cfnVpc.ref,
      cidrBlock: '10.0.21.0/24',
      availabilityZone: 'ap-northeast-1a',
      tags: [{ key: 'Name', value: buildResourceName(envName, 'db-subnet-1a') }],
    });

    // データベースサブネット 1c（ap-northeast-1c）
    const dbSubnet1c = new ec2.CfnSubnet(this, 'DbSubnet1c', {
      vpcId: cfnVpc.ref,
      cidrBlock: '10.0.22.0/24',
      availabilityZone: 'ap-northeast-1c',
      tags: [{ key: 'Name', value: buildResourceName(envName, 'db-subnet-1c') }],
    });

    // ============================================================
    // インターネットゲートウェイ作成・アタッチ
    // ============================================================

    // インターネットゲートウェイ
    const igw = new ec2.CfnInternetGateway(this, 'Igw', {
      tags: [{ key: 'Name', value: buildResourceName(envName, 'igw') }],
    });

    // VPC へのアタッチ
    const igwAttachment = new ec2.CfnVPCGatewayAttachment(this, 'IgwAttachment', {
      vpcId: cfnVpc.ref,
      internetGatewayId: igw.ref,
    });

    // ============================================================
    // Regional NAT Gateway 作成
    // VPC 単位の Regional NAT Gateway を作成し、複数 AZ のプライベートサブネットで共用する
    // ============================================================

    // Regional NAT Gateway（サブネット指定なし）
    const regionalNatGateway = new ec2.CfnNatGateway(this, 'RegionalNatGateway', {
      vpcId: cfnVpc.ref,
      availabilityMode: 'regional',
      connectivityType: 'public',
      tags: [{ key: 'Name', value: buildResourceName(envName, 'regional-nat-gw') }],
    });
    regionalNatGateway.addDependency(igwAttachment);

    // ============================================================
    // パブリックルートテーブル作成
    // デフォルトルート: 0.0.0.0/0 → インターネットゲートウェイ
    // ============================================================

    // パブリックルートテーブル
    
    const publicRouteTable = new ec2.CfnRouteTable(this, 'PublicRouteTable', {
      vpcId: cfnVpc.ref,
      tags: [{ key: 'Name', value: buildResourceName(envName, 'public-rtb') }],
    });

    // デフォルトルート（IGW 向け）
    new ec2.CfnRoute(this, 'PublicDefaultRoute', {
      routeTableId: publicRouteTable.ref,
      destinationCidrBlock: '0.0.0.0/0',
      gatewayId: igw.ref,
    });

    // パブリックサブネット 1a をルートテーブルに関連付け
    new ec2.CfnSubnetRouteTableAssociation(this, 'PublicSubnet1aRta', {
      subnetId: publicSubnet1a.ref,
      routeTableId: publicRouteTable.ref,
    });

    // パブリックサブネット 1c をルートテーブルに関連付け
    new ec2.CfnSubnetRouteTableAssociation(this, 'PublicSubnet1cRta', {
      subnetId: publicSubnet1c.ref,
      routeTableId: publicRouteTable.ref,
    });

    // ============================================================
    // プライベートルートテーブル作成
    // デフォルトルート: 0.0.0.0/0 → NAT Gateway
    // 単一 NAT Gateway 構成のため、1 つのルートテーブルを 2 サブネットで共用
    // ============================================================

    // プライベートルートテーブル
    const privateRouteTable = new ec2.CfnRouteTable(this, 'PrivateRouteTable', {
      vpcId: cfnVpc.ref,
      tags: [{ key: 'Name', value: buildResourceName(envName, 'private-rtb') }],
    });

    // デフォルトルート（Regional NAT Gateway 向け）
    new ec2.CfnRoute(this, 'PrivateDefaultRoute', {
      routeTableId: privateRouteTable.ref,
      destinationCidrBlock: '0.0.0.0/0',
      natGatewayId: regionalNatGateway.ref,
    });

    // プライベートサブネット 1a をルートテーブルに関連付け
    new ec2.CfnSubnetRouteTableAssociation(this, 'PrivateSubnet1aRta', {
      subnetId: privateSubnet1a.ref,
      routeTableId: privateRouteTable.ref,
    });

    // プライベートサブネット 1c を同一ルートテーブルに関連付け
    new ec2.CfnSubnetRouteTableAssociation(this, 'PrivateSubnet1cRta', {
      subnetId: privateSubnet1c.ref,
      routeTableId: privateRouteTable.ref,
    });

    // ============================================================
    // データベースルートテーブル作成（隔離: デフォルトルートなし）
    // ============================================================

    // データベースルートテーブル
    const dbRouteTable = new ec2.CfnRouteTable(this, 'DbRouteTable', {
      vpcId: cfnVpc.ref,
      tags: [{ key: 'Name', value: buildResourceName(envName, 'db-rtb') }],
    });

    // データベースサブネット 1a をルートテーブルに関連付け
    new ec2.CfnSubnetRouteTableAssociation(this, 'DbSubnet1aRta', {
      subnetId: dbSubnet1a.ref,
      routeTableId: dbRouteTable.ref,
    });

    // データベースサブネット 1c をルートテーブルに関連付け
    new ec2.CfnSubnetRouteTableAssociation(this, 'DbSubnet1cRta', {
      subnetId: dbSubnet1c.ref,
      routeTableId: dbRouteTable.ref,
    });

    // ============================================================
    // パブリックプロパティへの代入
    // ============================================================
    this.vpcId = cfnVpc.ref;
    this.publicSubnetIds = [publicSubnet1a.ref, publicSubnet1c.ref];
    this.privateSubnetIds = [privateSubnet1a.ref, privateSubnet1c.ref];
    this.dbSubnetIds = [dbSubnet1a.ref, dbSubnet1c.ref];

    // ============================================================
    // L2 VPC オブジェクト生成（fromVpcAttributes を使用）
    // 他スタックでサブネット選択などに使用するため L2 オブジェクトとして公開する
    // ============================================================
    this.vpc = ec2.Vpc.fromVpcAttributes(this, 'VpcL2', {
      vpcId: cfnVpc.ref,
      vpcCidrBlock: '10.0.0.0/16',
      availabilityZones: ['ap-northeast-1a', 'ap-northeast-1c'],
      publicSubnetIds: [publicSubnet1a.ref, publicSubnet1c.ref],
      publicSubnetRouteTableIds: [publicRouteTable.ref, publicRouteTable.ref],
      privateSubnetIds: [privateSubnet1a.ref, privateSubnet1c.ref],
      privateSubnetRouteTableIds: [privateRouteTable.ref, privateRouteTable.ref],
      isolatedSubnetIds: [dbSubnet1a.ref, dbSubnet1c.ref],
      isolatedSubnetRouteTableIds: [dbRouteTable.ref, dbRouteTable.ref],
    });

    // ============================================================
    // VPC Endpoint 作成（vpcEndpointsEnabled が true の場合のみ）
    // ============================================================
    if (envConfig.vpcEndpointsEnabled) {
      // ──────────────────────────────────────────
      // S3 ゲートウェイエンドポイント（追加コストなし）
      // 全ルートテーブルにルートを追加する
      // ──────────────────────────────────────────
      const allRouteTableIds = [
        publicRouteTable.ref,
        privateRouteTable.ref,
        dbRouteTable.ref,
      ];

      new ec2.CfnVPCEndpoint(this, 'S3GatewayEndpoint', {
        vpcId: cfnVpc.ref,
        serviceName: `com.amazonaws.ap-northeast-1.s3`,
        vpcEndpointType: 'Gateway',
        routeTableIds: allRouteTableIds,
      });

      // ──────────────────────────────────────────
      // インターフェースエンドポイント用セキュリティグループ
      // VPC CIDR（10.0.0.0/16）からの HTTPS アクセスを許可
      // ──────────────────────────────────────────
      const endpointSg = new ec2.SecurityGroup(this, 'EndpointSg', {
        vpc: this.vpc,
        description: 'VPC Interface Endpoint 用セキュリティグループ',
        securityGroupName: buildResourceName(envName, 'endpoint-sg'),
        allowAllOutbound: false,
      });

      // VPC 内部からの HTTPS (443) 通信を許可
      endpointSg.addIngressRule(
        ec2.Peer.ipv4('10.0.0.0/16'),
        ec2.Port.tcp(443),
        'VPC 内部からの HTTPS アクセスを許可',
      );

      // プライベートサブネット選択設定（インターフェースエンドポイント配置先）
      const privateSubnetSelection: ec2.SubnetSelection = {
        subnetType: ec2.SubnetType.PRIVATE_WITH_EGRESS,
      };

      // ──────────────────────────────────────────
      // ECR API インターフェースエンドポイント
      // コンテナイメージの認証・API 呼び出しに使用
      // ──────────────────────────────────────────
      new ec2.InterfaceVpcEndpoint(this, 'EcrApiEndpoint', {
        vpc: this.vpc,
        service: ec2.InterfaceVpcEndpointAwsService.ECR,
        subnets: privateSubnetSelection,
        securityGroups: [endpointSg],
        privateDnsEnabled: true,
      });

      // ──────────────────────────────────────────
      // ECR DKR インターフェースエンドポイント
      // Docker イメージのプル（レイヤー転送）に使用
      // ──────────────────────────────────────────
      new ec2.InterfaceVpcEndpoint(this, 'EcrDkrEndpoint', {
        vpc: this.vpc,
        service: ec2.InterfaceVpcEndpointAwsService.ECR_DOCKER,
        subnets: privateSubnetSelection,
        securityGroups: [endpointSg],
        privateDnsEnabled: true,
      });

      // ──────────────────────────────────────────
      // CloudWatch Logs インターフェースエンドポイント
      // Fargate タスクのログ送信に使用
      // ──────────────────────────────────────────
      new ec2.InterfaceVpcEndpoint(this, 'CloudWatchLogsEndpoint', {
        vpc: this.vpc,
        service: ec2.InterfaceVpcEndpointAwsService.CLOUDWATCH_LOGS,
        subnets: privateSubnetSelection,
        securityGroups: [endpointSg],
        privateDnsEnabled: true,
      });

      // ──────────────────────────────────────────
      // Secrets Manager インターフェースエンドポイント
      // DB 認証情報などのシークレット取得に使用
      // ──────────────────────────────────────────
      new ec2.InterfaceVpcEndpoint(this, 'SecretsManagerEndpoint', {
        vpc: this.vpc,
        service: ec2.InterfaceVpcEndpointAwsService.SECRETS_MANAGER,
        subnets: privateSubnetSelection,
        securityGroups: [endpointSg],
        privateDnsEnabled: true,
      });
    }
  }
}
