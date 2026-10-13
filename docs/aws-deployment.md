# Deploying and testing FlowForge on AWS (ECS Fargate + SQS)

These steps build this setup in one region:

```text
Internet ─▶ ALB :80 ─▶ ECS service flowforge-api (2 tasks) ─┬─▶ RDS PostgreSQL
                                     │ SendMessage           ├─▶ ElastiCache Redis
                                     ▼                       │
                        SQS flowforge-executions ──(5 failed receives)──▶ SQS flowforge-executions-dlq
                                     │ ReceiveMessage        │
                                     ▼                       │
                        ECS service flowforge-worker (5 tasks × 10 slots = 50 workers) ─┘
Logs: CloudWatch /ecs/flowforge      Secrets: Secrets Manager      Images: ECR
```

Run every command from the repository root in **Git Bash** (or AWS CloudShell), in **one terminal session**,
because later steps reuse shell variables from earlier ones. It uses the default VPC to keep networking simple.

**Cost:** about $1–2 per hour while everything runs (Fargate tasks, ALB, RDS, ElastiCache). The ALB, RDS and
ElastiCache keep billing until you delete them; see **10. Tear down**.

## 0. Prerequisites

```bash
aws --version                      # AWS CLI v2
aws configure                      # an IAM user/role with admin rights, for the one-time setup
docker --version
export AWS_REGION=us-east-1
export ACCOUNT_ID=$(aws sts get-caller-identity --query Account --output text)
export ECR_REPO=flowforge
export CLUSTER=flowforge
mkdir -p .aws-tmp                  # scratch folder for generated JSON (git-ignored)
```

## 1. Network and security groups

Each security group only lets traffic in from the layer in front of it.

```bash
VPC=$(aws ec2 describe-vpcs --filters Name=is-default,Values=true --query 'Vpcs[0].VpcId' --output text)
SUBNETS=$(aws ec2 describe-subnets --filters Name=vpc-id,Values=$VPC Name=default-for-az,Values=true --query 'Subnets[].SubnetId' --output text)
SUBNET_LIST=$(echo $SUBNETS | tr ' ' ',')

sg() { aws ec2 create-security-group --group-name "$1" --description "$1" --vpc-id $VPC --query GroupId --output text; }
ALB_SG=$(sg flowforge-alb);   aws ec2 authorize-security-group-ingress --group-id $ALB_SG --protocol tcp --port 80   --cidr 0.0.0.0/0
APP_SG=$(sg flowforge-app);   aws ec2 authorize-security-group-ingress --group-id $APP_SG --protocol tcp --port 3000 --source-group $ALB_SG
DB_SG=$(sg flowforge-db);     aws ec2 authorize-security-group-ingress --group-id $DB_SG  --protocol tcp --port 5432 --source-group $APP_SG
REDIS_SG=$(sg flowforge-redis); aws ec2 authorize-security-group-ingress --group-id $REDIS_SG --protocol tcp --port 6379 --source-group $APP_SG
```

## 2. PostgreSQL (RDS) and Redis (ElastiCache)

```bash
DB_PASSWORD=$(openssl rand -hex 16)
aws rds create-db-instance --db-instance-identifier flowforge-db \
  --engine postgres --engine-version 16 --db-instance-class db.t4g.micro --allocated-storage 20 \
  --master-username flowforge --master-user-password $DB_PASSWORD --db-name flowforge \
  --vpc-security-group-ids $DB_SG --no-publicly-accessible --backup-retention-period 0

aws elasticache create-cache-cluster --cache-cluster-id flowforge-redis \
  --engine redis --cache-node-type cache.t4g.micro --num-cache-nodes 1 --security-group-ids $REDIS_SG

aws rds wait db-instance-available --db-instance-identifier flowforge-db           # ~5-10 min
aws elasticache wait cache-cluster-available --cache-cluster-id flowforge-redis
DB_HOST=$(aws rds describe-db-instances --db-instance-identifier flowforge-db --query 'DBInstances[0].Endpoint.Address' --output text)
REDIS_HOST=$(aws elasticache describe-cache-clusters --cache-cluster-id flowforge-redis --show-cache-node-info \
  --query 'CacheClusters[0].CacheNodes[0].Endpoint.Address' --output text)
```

The app creates its tables on startup (`runMigrations`), so the database needs no manual setup.

## 3. SQS queue with a dead-letter queue

```bash
DLQ_URL=$(aws sqs create-queue --queue-name flowforge-executions-dlq --query QueueUrl --output text)
DLQ_ARN=$(aws sqs get-queue-attributes --queue-url $DLQ_URL --attribute-names QueueArn --query Attributes.QueueArn --output text)
cat > .aws-tmp/queue-attributes.json <<EOF
{
  "VisibilityTimeout": "30",
  "ReceiveMessageWaitTimeSeconds": "20",
  "RedrivePolicy": "{\"deadLetterTargetArn\":\"$DLQ_ARN\",\"maxReceiveCount\":\"5\"}"
}
EOF
QUEUE_URL=$(aws sqs create-queue --queue-name flowforge-executions --attributes file://.aws-tmp/queue-attributes.json --query QueueUrl --output text)
```

## 4. Secrets

The task definitions read `DATABASE_URL`, `REDIS_URL` and `AUTH_TOKEN_SECRET` from one Secrets Manager secret.

```bash
SECRET_ARN=$(aws secretsmanager create-secret --name flowforge/app --query ARN --output text --secret-string "{
  \"DATABASE_URL\": \"postgresql://flowforge:$DB_PASSWORD@$DB_HOST:5432/flowforge?sslmode=no-verify\",
  \"REDIS_URL\": \"redis://$REDIS_HOST:6379\",
  \"AUTH_TOKEN_SECRET\": \"$(openssl rand -hex 32)\"
}")
```

`sslmode=no-verify` encrypts the connection to RDS but skips certificate verification. For production, bundle the
RDS CA certificate and verify it.

## 5. IAM roles

```bash
cat > .aws-tmp/ecs-trust.json <<'EOF'
{ "Version": "2012-10-17", "Statement": [{ "Effect": "Allow", "Principal": { "Service": "ecs-tasks.amazonaws.com" }, "Action": "sts:AssumeRole" }] }
EOF

# Execution role: lets ECS pull the image, write logs, and read the secret.
aws iam create-role --role-name ecsTaskExecutionRole --assume-role-policy-document file://.aws-tmp/ecs-trust.json
aws iam attach-role-policy --role-name ecsTaskExecutionRole --policy-arn arn:aws:iam::aws:policy/service-role/AmazonECSTaskExecutionRolePolicy
aws iam put-role-policy --role-name ecsTaskExecutionRole --policy-name read-flowforge-secret --policy-document \
  "{\"Version\":\"2012-10-17\",\"Statement\":[{\"Effect\":\"Allow\",\"Action\":\"secretsmanager:GetSecretValue\",\"Resource\":\"$SECRET_ARN\"}]}"

# Task roles: what the app itself may do (API may only send, workers may only receive/delete/change visibility).
render() { sed "s|<account-id>|$ACCOUNT_ID|g; s|<region>|$AWS_REGION|g; s|<secrets-manager-arn>|$SECRET_ARN|g" "$1"; }
for name in api worker; do
  aws iam create-role --role-name flowforge-$name-task-role --assume-role-policy-document file://.aws-tmp/ecs-trust.json
  render deploy/aws/iam/flowforge-$name-policy.json > .aws-tmp/$name-policy.json
  aws iam put-role-policy --role-name flowforge-$name-task-role --policy-name sqs --policy-document file://.aws-tmp/$name-policy.json
done
```

If `ecsTaskExecutionRole` already exists in your account, `create-role` fails with "EntityAlreadyExists". That is fine; the next two commands still apply.

## 6. Build the image and push it to ECR

```bash
aws ecr create-repository --repository-name $ECR_REPO
REGISTRY=$ACCOUNT_ID.dkr.ecr.$AWS_REGION.amazonaws.com
aws ecr get-login-password | docker login --username AWS --password-stdin $REGISTRY
IMAGE=$REGISTRY/$ECR_REPO:v1
docker build --platform linux/amd64 -t $IMAGE app
docker push $IMAGE
```

## 7. Load balancer, cluster, task definitions, services

```bash
aws logs create-log-group --log-group-name /ecs/flowforge
aws ecs create-cluster --cluster-name $CLUSTER

ALB_ARN=$(aws elbv2 create-load-balancer --name flowforge-alb --subnets $SUBNETS --security-groups $ALB_SG \
  --query 'LoadBalancers[0].LoadBalancerArn' --output text)
ALB_DNS=$(aws elbv2 describe-load-balancers --load-balancer-arns $ALB_ARN --query 'LoadBalancers[0].DNSName' --output text)
TG_ARN=$(aws elbv2 create-target-group --name flowforge-api --protocol HTTP --port 3000 --vpc-id $VPC \
  --target-type ip --health-check-path /health --query 'TargetGroups[0].TargetGroupArn' --output text)
aws elbv2 create-listener --load-balancer-arn $ALB_ARN --protocol HTTP --port 80 \
  --default-actions Type=forward,TargetGroupArn=$TG_ARN

# Fill in the placeholders and the image, then register both task definitions.
for name in api worker; do
  render deploy/aws/ecs/$name-task-definition.json | sed "s|replaced-by-ci|$IMAGE|" > .aws-tmp/$name-task.json
  aws ecs register-task-definition --cli-input-json file://.aws-tmp/$name-task.json
done

NET="awsvpcConfiguration={subnets=[$SUBNET_LIST],securityGroups=[$APP_SG],assignPublicIp=ENABLED}"
aws ecs create-service --cluster $CLUSTER --service-name flowforge-api --task-definition flowforge-api \
  --desired-count 2 --launch-type FARGATE --network-configuration "$NET" \
  --load-balancers targetGroupArn=$TG_ARN,containerName=flowforge-api,containerPort=3000
aws ecs create-service --cluster $CLUSTER --service-name flowforge-worker --task-definition flowforge-worker \
  --desired-count 5 --launch-type FARGATE --network-configuration "$NET"

aws ecs wait services-stable --cluster $CLUSTER --services flowforge-api flowforge-worker
echo "API: http://$ALB_DNS"
```

`assignPublicIp=ENABLED` lets tasks in the default VPC's public subnets pull from ECR and reach SQS without a NAT
gateway. A production setup would use private subnets with a NAT gateway or VPC endpoints.

## 8. Test it on AWS

### 8.1 Smoke test

```bash
curl -s http://$ALB_DNS/health        # {"status":"ok","database":"ok","redis":"ok"}
curl -s http://$ALB_DNS/metrics       # "workers": {"active": 50, ...} once all 5 worker tasks are up
aws logs tail /ecs/flowforge --since 5m | grep worker.started   # each line shows "queue":"sqs"
```

### 8.2 Open the database to your IP (only for the test run)

The test scripts read PostgreSQL directly to compute their numbers. RDS is private, so allow your IP for the
duration of the tests, then close it again (see 8.6).

```bash
MY_IP=$(curl -s https://checkip.amazonaws.com)
aws ec2 authorize-security-group-ingress --group-id $DB_SG --protocol tcp --port 5432 --cidr $MY_IP/32
aws rds modify-db-instance --db-instance-identifier flowforge-db --publicly-accessible --apply-immediately
aws rds wait db-instance-available --db-instance-identifier flowforge-db
export API_URL=http://$ALB_DNS
export DATABASE_URL="postgresql://flowforge:$DB_PASSWORD@$DB_HOST:5432/flowforge?sslmode=no-verify"
cd app && npm ci
```

### 8.3 End-to-end test

```bash
npm run test:e2e
```

It checks auth, DAG execution, concurrent idempotency, retries with backoff, the dead-letter list and replay,
non-retryable errors, rate-limit headers and metrics, all through the ALB.

### 8.4 Load test (10,000 jobs, 50 workers)

The load test submits 2,000 runs as one user, so raise the rate limit first: deploy a new API revision with
`RATE_LIMIT_MAX_REQUESTS=100000`.

```bash
cd ..
render deploy/aws/ecs/api-task-definition.json | sed "s|replaced-by-ci|$IMAGE|; s|\"value\": \"100\"|\"value\": \"100000\"|" > .aws-tmp/api-task.json
aws ecs register-task-definition --cli-input-json file://.aws-tmp/api-task.json
aws ecs update-service --cluster $CLUSTER --service flowforge-api --task-definition flowforge-api
aws ecs wait services-stable --cluster $CLUSTER --services flowforge-api
cd app
RESULT_FILE=../docs/results/aws-load-test.json npm run test:load
```

While it runs, open the SQS console. **ApproximateNumberOfMessagesVisible** rises and falls as the workers drain the queue.

### 8.5 Failure-injection test on ECS

`CHAOS=ecs` stops 2 worker tasks twice during the run, using `aws ecs stop-task`. The ECS service replaces them automatically.

```bash
CHAOS=ecs ECS_CLUSTER=$CLUSTER RESULT_FILE=../docs/results/aws-failure-test.json npm run test:failure
```

`stop-task` sends SIGTERM, so this tests **graceful shutdown during a deploy or scale-in**: workers finish their
in-flight jobs before exiting, and you should see few or no `LOST` attempts. The **hard-crash** path (SIGKILL) is what
the local Docker run covers. Both are worth describing in an interview.

Test the **SQS dead-letter queue** with a message no worker can process:

```bash
aws sqs send-message --queue-url $QUEUE_URL --message-body 'not-json'
sleep 200   # 5 receives × 30 s visibility timeout
aws sqs get-queue-attributes --queue-url $DLQ_URL --attribute-names ApproximateNumberOfMessages
# => "ApproximateNumberOfMessages": "1"
```

Look at the logs in **CloudWatch Logs Insights** (log group `/ecs/flowforge`):

```text
fields @timestamp, event, jobId, step, attempt, error
| filter event in ["job.retry_scheduled", "job.dead_lettered", "execution.recovered_lost_jobs"]
| sort @timestamp desc
```

### 8.6 Close the database again and restore the rate limit

```bash
aws rds modify-db-instance --db-instance-identifier flowforge-db --no-publicly-accessible --apply-immediately
aws ec2 revoke-security-group-ingress --group-id $DB_SG --protocol tcp --port 5432 --cidr $MY_IP/32
cd .. && render deploy/aws/ecs/api-task-definition.json | sed "s|replaced-by-ci|$IMAGE|" > .aws-tmp/api-task.json
aws ecs register-task-definition --cli-input-json file://.aws-tmp/api-task.json
aws ecs update-service --cluster $CLUSTER --service flowforge-api --task-definition flowforge-api
```

## 9. Turn on CI/CD (GitHub Actions → ECR → ECS)

After this, every push to `master` that passes the tests deploys automatically. GitHub signs in to AWS with OIDC, so
no AWS keys are stored in GitHub.

```bash
aws iam create-open-id-connect-provider --url https://token.actions.githubusercontent.com --client-id-list sts.amazonaws.com

cat > .aws-tmp/github-trust.json <<EOF
{ "Version": "2012-10-17", "Statement": [{ "Effect": "Allow",
  "Principal": { "Federated": "arn:aws:iam::$ACCOUNT_ID:oidc-provider/token.actions.githubusercontent.com" },
  "Action": "sts:AssumeRoleWithWebIdentity",
  "Condition": {
    "StringEquals": { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" },
    "StringLike":   { "token.actions.githubusercontent.com:sub": "repo:avinash-p05/flow-forge:ref:refs/heads/master" } } }] }
EOF
cat > .aws-tmp/github-deploy.json <<EOF
{ "Version": "2012-10-17", "Statement": [
  { "Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*" },
  { "Effect": "Allow", "Action": ["ecr:BatchCheckLayerAvailability","ecr:InitiateLayerUpload","ecr:UploadLayerPart",
      "ecr:CompleteLayerUpload","ecr:PutImage","ecr:BatchGetImage"],
    "Resource": "arn:aws:ecr:$AWS_REGION:$ACCOUNT_ID:repository/$ECR_REPO" },
  { "Effect": "Allow", "Action": ["ecs:RegisterTaskDefinition","ecs:DescribeTaskDefinition","ecs:UpdateService","ecs:DescribeServices"], "Resource": "*" },
  { "Effect": "Allow", "Action": "iam:PassRole", "Resource": [
      "arn:aws:iam::$ACCOUNT_ID:role/ecsTaskExecutionRole",
      "arn:aws:iam::$ACCOUNT_ID:role/flowforge-api-task-role",
      "arn:aws:iam::$ACCOUNT_ID:role/flowforge-worker-task-role" ] } ] }
EOF
aws iam create-role --role-name flowforge-github-deploy --assume-role-policy-document file://.aws-tmp/github-trust.json
aws iam put-role-policy --role-name flowforge-github-deploy --policy-name deploy --policy-document file://.aws-tmp/github-deploy.json

gh variable set AWS_REGION          --body $AWS_REGION
gh variable set AWS_ACCOUNT_ID      --body $ACCOUNT_ID
gh variable set AWS_DEPLOY_ROLE_ARN --body arn:aws:iam::$ACCOUNT_ID:role/flowforge-github-deploy
gh variable set ECR_REPOSITORY      --body $ECR_REPO
gh variable set ECS_CLUSTER         --body $CLUSTER
gh variable set APP_SECRET_ARN      --body $SECRET_ARN
```

Push to `master` and watch **Actions → CI/CD**: `test` runs first; `deploy` then pushes the image tagged with the
commit SHA and rolls both services, waiting until they are stable.

## 10. Tear down

```bash
aws ecs update-service --cluster $CLUSTER --service flowforge-api --desired-count 0
aws ecs update-service --cluster $CLUSTER --service flowforge-worker --desired-count 0
aws ecs delete-service --cluster $CLUSTER --service flowforge-api --force
aws ecs delete-service --cluster $CLUSTER --service flowforge-worker --force
aws elbv2 delete-load-balancer --load-balancer-arn $ALB_ARN
aws rds delete-db-instance --db-instance-identifier flowforge-db --skip-final-snapshot
aws elasticache delete-cache-cluster --cache-cluster-id flowforge-redis
aws sqs delete-queue --queue-url $QUEUE_URL && aws sqs delete-queue --queue-url $DLQ_URL
aws secretsmanager delete-secret --secret-id $SECRET_ARN --force-delete-without-recovery
aws ecr delete-repository --repository-name $ECR_REPO --force
sleep 60 && aws elbv2 delete-target-group --target-group-arn $TG_ARN
aws ecs delete-cluster --cluster $CLUSTER
# Security groups can be deleted once RDS/ElastiCache are gone (a few minutes):
# for g in $REDIS_SG $DB_SG $APP_SG $ALB_SG; do aws ec2 delete-security-group --group-id $g; done
```

Take screenshots before tearing down (ECS services with 5 running worker tasks, the SQS graphs, CloudWatch Logs
Insights, `/metrics`). They are good evidence for "deployed on AWS" if you are asked about it.
