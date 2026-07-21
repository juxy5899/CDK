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
    // AZ と CIDR のマッピング定義（サブネット批量作成用）
    // 東京環境固定（dev/stg）、将来 DR（大阪）対応時は environment から AZ リストを取得
    // ============================================================
    const azConfigs = [
      {
        id: '1a',
        az: 'ap-northeast-1a',
        pub: '10.0.1.0/24',
        priv: '10.0.11.0/24',
        db: '10.0.21.0/24',
      },
      {
        id: '1c',
        az: 'ap-northeast-1c',
        pub: '10.0.2.0/24',
        priv: '10.0.12.0/24',
        db: '10.0.22.0/24',
      },
    ];

    const selectedAzs = azConfigs.map((c) => c.az);

    // ============================================================
    // 各層のサブネット批量作成（2 AZ）
    // ============================================================
    const publicSubnets = azConfigs.map(
      (c) =>
        new ec2.CfnSubnet(this, `PublicSubnet${c.id}`, {
          vpcId: cfnVpc.ref,
          cidrBlock: c.pub,
          availabilityZone: c.az,
          mapPublicIpOnLaunch: true,
          tags: [{ key: 'Name', value: buildResourceName(envName, `public-subnet-${c.id}`) }],
        }),
    );

    const privateSubnets = azConfigs.map(
      (c) =>
        new ec2.CfnSubnet(this, `PrivateSubnet${c.id}`, {
          vpcId: cfnVpc.ref,
          cidrBlock: c.priv,
          availabilityZone: c.az,
          tags: [{ key: 'Name', value: buildResourceName(envName, `private-subnet-${c.id}`) }],
        }),
    );

    const dbSubnets = azConfigs.map(
      (c) =>
        new ec2.CfnSubnet(this, `DbSubnet${c.id}`, {
          vpcId: cfnVpc.ref,
          cidrBlock: c.db,
          availabilityZone: c.az,
          tags: [{ key: 'Name', value: buildResourceName(envName, `db-subnet-${c.id}`) }],
        }),
    );

    // ============================================================
    // インターネットゲートウェイ作成・アタッチ
    // ============================================================
    const igw = new ec2.CfnInternetGateway(this, 'Igw', {
      tags: [{ key: 'Name', value: buildResourceName(envName, 'igw') }],
    });

    const igwAttachment = new ec2.CfnVPCGatewayAttachment(this, 'IgwAttachment', {
      vpcId: cfnVpc.ref,
      internetGatewayId: igw.ref,
    });

    // ============================================================
    // Regional NAT Gateway 用 Elastic IP（AZ ごとの固定送信元 IP）
    // JPKI や mypage など外部連携先へ通知する送信元 IP として使用する
    // ============================================================
    const natGatewayEip1a = new ec2.CfnEIP(this, 'RegionalNatGatewayEip1a', {
      domain: 'vpc',
      tags: [{ key: 'Name', value: buildResourceName(envName, 'regional-nat-eip-1a') }],
    });
    natGatewayEip1a.addDependency(igwAttachment);

    const natGatewayEip1c = new ec2.CfnEIP(this, 'RegionalNatGatewayEip1c', {
      domain: 'vpc',
      tags: [{ key: 'Name', value: buildResourceName(envName, 'regional-nat-eip-1c') }],
    });
    natGatewayEip1c.addDependency(igwAttachment);

    // ============================================================
    // Regional NAT Gateway 作成
    // VPC 単位の Regional NAT Gateway を作成し、複数 AZ のプライベートサブネットで共用する
    // ============================================================
    const regionalNatGateway = new ec2.CfnNatGateway(this, 'RegionalNatGateway', {
      vpcId: cfnVpc.ref,
      availabilityMode: 'regional',
      connectivityType: 'public',
      availabilityZoneAddresses: [
        {
          availabilityZone: azConfigs[0].az,
          allocationIds: [natGatewayEip1a.attrAllocationId],
        },
        {
          availabilityZone: azConfigs[1].az,
          allocationIds: [natGatewayEip1c.attrAllocationId],
        },
      ],
      tags: [{ key: 'Name', value: buildResourceName(envName, 'regional-nat-gw') }],
    });
    regionalNatGateway.addDependency(igwAttachment);

    // ============================================================
    // EIP 情報を出力（全環境で有効）
    // ============================================================
    new cdk.CfnOutput(this, 'RegionalNatGatewayEip1aAllocationId', {
      value: natGatewayEip1a.attrAllocationId,
    });

    new cdk.CfnOutput(this, 'RegionalNatGatewayEip1aPublicIp', {
      value: natGatewayEip1a.attrPublicIp,
    });

    new cdk.CfnOutput(this, 'RegionalNatGatewayEip1cAllocationId', {
      value: natGatewayEip1c.attrAllocationId,
    });

    new cdk.CfnOutput(this, 'RegionalNatGatewayEip1cPublicIp', {
      value: natGatewayEip1c.attrPublicIp,
    });

    // ============================================================
    // ルートテーブル作成と関連付け
    // ============================================================

    // --- パブリックルートテーブル（0.0.0.0/0 → IGW）---
    const publicRouteTable = new ec2.CfnRouteTable(this, 'PublicRouteTable', {
      vpcId: cfnVpc.ref,
      tags: [{ key: 'Name', value: buildResourceName(envName, 'public-rtb') }],
    });

    const publicDefaultRoute = new ec2.CfnRoute(this, 'PublicDefaultRoute', {
      routeTableId: publicRouteTable.ref,
      destinationCidrBlock: '0.0.0.0/0',
      gatewayId: igw.ref,
    });
    publicDefaultRoute.addDependency(igwAttachment);

    publicSubnets.forEach((subnet, index) => {
      new ec2.CfnSubnetRouteTableAssociation(this, `PublicSubnetRta${index}`, {
        subnetId: subnet.ref,
        routeTableId: publicRouteTable.ref,
      });
    });

    // --- プライベートルートテーブル（0.0.0.0/0 → Regional NAT）---
    const privateRouteTable = new ec2.CfnRouteTable(this, 'PrivateRouteTable', {
      vpcId: cfnVpc.ref,
      tags: [{ key: 'Name', value: buildResourceName(envName, 'private-rtb') }],
    });

    new ec2.CfnRoute(this, 'PrivateDefaultRoute', {
      routeTableId: privateRouteTable.ref,
      destinationCidrBlock: '0.0.0.0/0',
      natGatewayId: regionalNatGateway.ref,
    });

    privateSubnets.forEach((subnet, index) => {
      new ec2.CfnSubnetRouteTableAssociation(this, `PrivateSubnetRta${index}`, {
        subnetId: subnet.ref,
        routeTableId: privateRouteTable.ref,
      });
    });

    // --- データベースルートテーブル（隔離: デフォルトルートなし）---
    const dbRouteTable = new ec2.CfnRouteTable(this, 'DbRouteTable', {
      vpcId: cfnVpc.ref,
      tags: [{ key: 'Name', value: buildResourceName(envName, 'db-rtb') }],
    });

    dbSubnets.forEach((subnet, index) => {
      new ec2.CfnSubnetRouteTableAssociation(this, `DbSubnetRta${index}`, {
        subnetId: subnet.ref,
        routeTableId: dbRouteTable.ref,
      });
    });

    // ============================================================
    // パブリックプロパティへの代入
    // ============================================================
    this.vpcId = cfnVpc.ref;
    this.publicSubnetIds = publicSubnets.map((s) => s.ref);
    this.privateSubnetIds = privateSubnets.map((s) => s.ref);
    this.dbSubnetIds = dbSubnets.map((s) => s.ref);

    // ============================================================
    // L2 VPC オブジェクト生成（fromVpcAttributes を使用）
    // 他スタックでサブネット選択などに使用するため L2 オブジェクトとして公開する
    // ============================================================
    this.vpc = ec2.Vpc.fromVpcAttributes(this, 'VpcL2', {
      vpcId: cfnVpc.ref,
      vpcCidrBlock: '10.0.0.0/16',
      availabilityZones: selectedAzs,
      publicSubnetIds: this.publicSubnetIds,
      publicSubnetRouteTableIds: publicSubnets.map(() => publicRouteTable.ref),
      privateSubnetIds: this.privateSubnetIds,
      privateSubnetRouteTableIds: privateSubnets.map(() => privateRouteTable.ref),
      isolatedSubnetIds: this.dbSubnetIds,
      isolatedSubnetRouteTableIds: dbSubnets.map(() => dbRouteTable.ref),
    });

    // ============================================================
    // VPC Endpoint 作成
    // ============================================================
    if (envConfig.s3GatewayEndpointEnabled) {
      // ──────────────────────────────────────────
      // S3 ゲートウェイエンドポイント（追加コストなし）
      // 全ルートテーブルにルートを追加する
      // ──────────────────────────────────────────
      const allRouteTableIds = [publicRouteTable.ref, privateRouteTable.ref, dbRouteTable.ref];

      new ec2.CfnVPCEndpoint(this, 'S3GatewayEndpoint', {
        vpcId: cfnVpc.ref,
        serviceName: cdk.Fn.sub('com.amazonaws.${AWS::Region}.s3', {}),
        vpcEndpointType: 'Gateway',
        routeTableIds: allRouteTableIds,
      });
    }

    if (envConfig.interfaceVpcEndpointsEnabled) {
      // ──────────────────────────────────────────
      // インターフェースエンドポイント用セキュリティグループ
      // VPC CIDR（10.0.0.0/16）からの HTTPS アクセスを許可
      // 現行構成では ECR API / ECR DKR / CloudWatch Logs / Secrets Manager を作成する
      // SQS / EventBridge / X-Ray / KMS / STS / Lambda / SSM / CloudWatch Monitoring / MediaConvert は、
      // 対象ワークロードからの利用状況と各サービスの PrivateLink 対応状況に応じて追加する
      // ──────────────────────────────────────────
      const endpointSg = new ec2.SecurityGroup(this, 'EndpointSg', {
        vpc: this.vpc,
        description: 'Security group for VPC interface endpoints',
        securityGroupName: buildResourceName(envName, 'endpoint-sg'),
        allowAllOutbound: false,
      });

      // VPC 内部からの HTTPS (443) 通信を許可
      endpointSg.addIngressRule(
        ec2.Peer.ipv4('10.0.0.0/16'),
        ec2.Port.tcp(443),
        'Allow HTTPS access from inside the VPC',
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
