import * as cdk from "aws-cdk-lib";
import { Construct } from "constructs";
import * as fs from "fs";
import * as path from "path";

export interface AutoScalingGroupProps {
  vpc: cdk.aws_ec2.IVpc;
}

export class AutoScalingGroup extends Construct {
  readonly asg: cdk.aws_autoscaling.AutoScalingGroup;

  constructor(scope: Construct, id: string, props: AutoScalingGroupProps) {
    super(scope, id);

    const autoScalingGroupName = "asg";
    const maxCapacity = 10;
    const hostname_prefix = "web";
    const hostname_domain = "corp.non-97.net";

    // IAM Role
    const role = new cdk.aws_iam.Role(this, "Role", {
      assumedBy: new cdk.aws_iam.ServicePrincipal("ec2.amazonaws.com"),
      managedPolicies: [
        new cdk.aws_iam.ManagedPolicy(this, "Policy", {
          statements: [
            new cdk.aws_iam.PolicyStatement({
              effect: cdk.aws_iam.Effect.ALLOW,
              resources: ["*"],
              actions: [
                "ec2:AttachNetworkInterface",
                "ec2:DescribeNetworkInterfaces",
              ],
            }),
            new cdk.aws_iam.PolicyStatement({
              effect: cdk.aws_iam.Effect.ALLOW,
              resources: ["*"],
              actions: ["ec2:CreateTags"],
              conditions: {
                StringEquals: {
                  "aws:ResourceTag/aws:autoscaling:groupName":
                    autoScalingGroupName,
                },
              },
            }),
          ],
        }),
      ],
    });

    // User data
    const userDataScript = fs.readFileSync(
      path.join(__dirname, "../ec2/user-data.sh"),
      "utf8"
    );
    const userData = cdk.aws_ec2.UserData.forLinux();
    userData.addCommands(userDataScript);

    // Auto Scaling Group
    this.asg = new cdk.aws_autoscaling.AutoScalingGroup(this, "Default", {
      autoScalingGroupName,
      machineImage: cdk.aws_ec2.MachineImage.latestAmazonLinux2023({
        cachedInContext: true,
      }),
      instanceType: new cdk.aws_ec2.InstanceType("t3.nano"),
      vpc: props.vpc,
      vpcSubnets: props.vpc.selectSubnets({
        subnetGroupName: "Public",
      }),
      maxCapacity,
      minCapacity: 10,
      role,
      ssmSessionPermissions: true,
      userData,
      healthCheck: cdk.aws_autoscaling.HealthCheck.elb({
        grace: cdk.Duration.minutes(3),
      }),
    });
    this.asg.scaleOnCpuUtilization("CpuScaling", {
      targetUtilizationPercent: 50,
    });

    // Generate IP Address
    const generateIpAddress = (cidr: string, index: number): string => {
      const [networkAddress, mask] = cidr.split("/");
      const networkAddressOctets = networkAddress.split(".").map(Number);
      const maskBit = Number(mask);
      const availableIpAddressesNumber = Math.pow(2, 32 - maskBit) - 5;
      const startIpAddressBit =
        networkAddressOctets.reduce(
          (accumulator, current, index) =>
            accumulator + (current << ((3 - index) * 8)),
          0
        ) + 4;

      if (index < 0 || index >= availableIpAddressesNumber) {
        return "Error: The provided index is out of range.";
      }

      const ipAddressBit = startIpAddressBit + index;

      const ipAddress = [3, 2, 1, 0]
        .map((shift) => (ipAddressBit >>> (shift * 8)) % 256)
        .join(".");

      return ipAddress;
    };

    // ENI
    const subnet = props.vpc.selectSubnets({
      subnetGroupName: "Public",
    }).subnets;

    for (let i = 0; i < maxCapacity; i++) {
      const subnetId = subnet[i % subnet.length].subnetId;
      const subnetCidr = subnet[i % subnet.length].ipv4CidrBlock;
      const availabilityZone = subnet[i % subnet.length].availabilityZone;

      new cdk.aws_ec2.CfnNetworkInterface(this, `Eni${i}`, {
        subnetId,
        groupSet: [this.asg.connections.securityGroups[0].securityGroupId],
        privateIpAddress: generateIpAddress(
          subnetCidr,
          Math.floor(i / subnet.length)
        ),
        tags: [
          {
            key: "HostName",
            value: `${hostname_prefix}-${availabilityZone}-${Math.floor(
              i / subnet.length
            )}.${hostname_domain}`,
          },
        ],
      });
    }
  }
}
