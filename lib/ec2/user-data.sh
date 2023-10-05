#!/bin/bash

set -u

# Redirect /var/log/user-data.log and /dev/console
exec > >(tee /var/log/user-data.log | logger -t user-data -s 2>/dev/console) 2>&1

declare -r max_retry_interval=8
declare -r max_retries=16

# Get my instance ID
token=$(curl \
  -s \
  -X PUT \
  -H "X-aws-ec2-metadata-token-ttl-seconds: 21600" \
  "http://169.254.169.254/latest/api/token"
)
instance_id=$(curl \
  -s \
  -H "X-aws-ec2-metadata-token: $token" \
  "http://169.254.169.254/latest/meta-data/instance-id"
)

# MAC Address
mac_address=$(curl \
  -s \
  -H "X-aws-ec2-metadata-token: $token" \
  "http://169.254.169.254/latest/meta-data/mac"
)

# Subnet ID
region=$(curl \
  -s \
  -H "X-aws-ec2-metadata-token: $token" \
  "http://169.254.169.254/latest/meta-data/placement/region"
)

# Subnet ID
subnet_id=$(curl \
  -s \
  -H "X-aws-ec2-metadata-token: $token" \
  "http://169.254.169.254/latest/meta-data/network/interfaces/macs/$mac_address/subnet-id"
)

for i in $(seq 1 $max_retries); do
  # Available ENI ID
  eni_id=$(aws ec2 describe-network-interfaces \
    --filters Name=subnet-id,Values=$subnet_id \
      Name=status,Values=available \
    --query 'sort_by(NetworkInterfaces[], &TagSet[?Key==`HostName`].Value | [0])[].NetworkInterfaceId | [0]' \
    --region $region \
    --output text
  )

  if [[ $eni_id == 'None' ]]; then
    retry_interval=$(($RANDOM % $max_retry_interval))

    echo "ENI not found, retrying in $retry_interval seconds..."
    sleep $retry_interval

    continue
  fi

  # Attach ENI
  aws ec2 attach-network-interface \
    --instance-id=$instance_id \
    --device-index=1 \
    --network-interface-id=$eni_id \
    --region $region

  if [[ $? == 0 ]]; then
    hostname=$(aws ec2 describe-network-interfaces \
      --network-interface-ids $eni_id \
      --query "NetworkInterfaces[].TagSet[?Key=='HostName'].Value" \
      --region $region \
      --output text
    )

    echo "Set HostName ${hostname}"

    aws ec2 create-tags \
      --resources $instance_id \
      --tags Key=HostName,Value=$hostname \
      --region $region

    hostnamectl set-hostname "${hostname}"

    echo "hostnamectl :
      $(hostnamectl)"

    break
  else
    retry_interval=$(($RANDOM % $max_retry_interval))

    echo "Failed to attach ENI, retrying in $retry_interval seconds..."
    sleep $retry_interval
  fi
done

# If the loop exhausted retries, fail and suggest manual assignment
if [[ $i == $max_retries ]]; then
  echo "Failed to allocate a unique hostname after $max_retries retries. Please manually assign a hostname."
fi