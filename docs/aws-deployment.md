# Deploying and testing FlowForge on AWS (Console)

This guide uses the **AWS Management Console** for everything except two things the console can't do:
pushing the Docker image (step 6) and running the test scripts (step 9).

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

**Before you start**

- Pick one region in the top-right corner (e.g. **Asia Pacific (Mumbai) ap-south-1**) and keep using it for every step.
- Keep a notepad open. You will copy values like the account ID, ARNs and endpoints from one page into another.
  Your **account ID** is in the account menu (top right).
- Everything goes in the **default VPC**, which keeps networking simple.
- **Cost:** about $1–2 per hour while it runs. The load balancer, RDS and ElastiCache bill until you delete them;
  see step 11.

---

## 1. Security groups (EC2 → Security Groups → Create security group)

Create four, all in the default VPC. Each one only lets traffic in from the layer in front of it.

| Name | Inbound rule | Source |
|---|---|---|
| `flowforge-alb` | HTTP, port 80 | Anywhere-IPv4 (`0.0.0.0/0`) |
| `flowforge-app` | Custom TCP, port 3000 | the `flowforge-alb` security group |
| `flowforge-db` | PostgreSQL, port 5432 | the `flowforge-app` security group |
| `flowforge-redis` | Custom TCP, port 6379 | the `flowforge-app` security group |

Leave outbound rules at the default (all traffic allowed).

## 2. PostgreSQL (RDS → Databases → Create database)

- **Standard create** → Engine **PostgreSQL**, version **16.x**
- Template: **Free tier** (or Dev/Test)
- DB instance identifier: `flowforge-db`
- Master username `flowforge`, **self managed** password. Save the password in your notepad.
- Instance class: **db.t4g.micro**, storage **20 GiB gp3**
- Connectivity: default VPC, **Public access: No**, VPC security group: **choose existing → `flowforge-db`**
  (remove `default`)
- Additional configuration → **Initial database name: `flowforge`**; turn off automated backups for a demo
- Create, then wait until the status is **Available** (~10 min). Copy the **Endpoint** (Connectivity & security tab).

The app creates its tables the first time it starts, so the database needs no further setup.

## 3. Redis (ElastiCache → Redis OSS caches → Create)

- **Design your own cache** → **Node-based cluster**, cluster mode **Disabled**
- Name `flowforge-redis`, node type **cache.t4g.micro**, **0 replicas**, Multi-AZ off
- Subnet group: create a new one on the default VPC (select all its subnets)
- Security: **Encryption in transit: off** (so the URL is plain `redis://`), security group **`flowforge-redis`**
- Create and wait for **Available**. Copy the **Primary endpoint** without the `:6379`.

If you leave encryption in transit on, the Redis URL in step 5 must start with `rediss://`.

## 4. SQS queues (Amazon SQS → Create queue)

1. **Dead-letter queue first:** type **Standard**, name `flowforge-executions-dlq`, defaults → Create.
2. **Main queue:** type **Standard**, name `flowforge-executions`
   - Visibility timeout **30 seconds**, Receive message wait time **20 seconds**
   - **Dead-letter queue: Enabled** → choose `flowforge-executions-dlq`, **Maximum receives: 5**
   - Create. Copy its **URL** (`https://sqs.<region>.amazonaws.com/<account-id>/flowforge-executions`).

## 5. Secret (Secrets Manager → Store a new secret)

- Type **Other type of secret** → add three key/value pairs:

| Key | Value |
|---|---|
| `DATABASE_URL` | `postgresql://flowforge:<db-password>@<rds-endpoint>:5432/flowforge?sslmode=no-verify` |
| `REDIS_URL` | `redis://<redis-endpoint>:6379` |
| `AUTH_TOKEN_SECRET` | any random string of 32+ characters |

- Secret name `flowforge/app`, no rotation → Store. Open it and copy the **Secret ARN**.

`sslmode=no-verify` encrypts the connection to RDS but skips certificate verification. For real production,
bundle the RDS CA certificate and verify it.

## 6. Container image (ECR, plus one terminal step)

1. **ECR → Private repositories → Create repository**, name `flowforge`.
2. Install the AWS CLI on your machine and run `aws configure` once, using an access key for your IAM user
   (IAM → Users → you → Security credentials → Create access key).
3. Open the repository → **View push commands**, then run the four commands it shows from the `app/` folder of this repo.
   On Windows or an Apple-silicon Mac, add `--platform linux/amd64` to the `docker build` command.
4. Copy the **image URI**, e.g. `<account-id>.dkr.ecr.<region>.amazonaws.com/flowforge:latest`.

## 7. IAM roles (IAM → Roles → Create role)

For each role: **Trusted entity: AWS service → Elastic Container Service → Elastic Container Service Task**.

| Role name | Permissions |
|---|---|
| `ecsTaskExecutionRole` (skip it if it already exists) | Attach the managed policy **AmazonECSTaskExecutionRolePolicy**, then **Add permissions → Create inline policy → JSON** with the policy below. |
| `flowforge-api-task-role` | Inline policy: paste [deploy/aws/iam/flowforge-api-policy.json](../deploy/aws/iam/flowforge-api-policy.json) (replace `<region>` and `<account-id>`) |
| `flowforge-worker-task-role` | Inline policy: paste [deploy/aws/iam/flowforge-worker-policy.json](../deploy/aws/iam/flowforge-worker-policy.json) (replace `<region>` and `<account-id>`) |

Inline policy for `ecsTaskExecutionRole` (it lets ECS read the secret and inject it into the containers):

```json
{
  "Version": "2012-10-17",
  "Statement": [{ "Effect": "Allow", "Action": "secretsmanager:GetSecretValue", "Resource": "<secret-arn>" }]
}
```

The API role can only **send** to the queue, and the worker role can only **receive, delete and change visibility**.
That's least privilege.

## 8. Load balancer, logs, cluster, task definitions, services

### 8.1 Target group (EC2 → Target groups → Create target group)

- Target type **IP addresses**, name `flowforge-api`, protocol **HTTP**, port **3000**, default VPC
- Health check path **`/health`** → Next → **don't register any targets** (ECS does that) → Create

### 8.2 Load balancer (EC2 → Load balancers → Create → Application Load Balancer)

- Name `flowforge-alb`, **Internet-facing**, IPv4, default VPC, select **all** subnets
- Security group: **`flowforge-alb`** only
- Listener **HTTP : 80** → forward to **`flowforge-api`** → Create. Copy the **DNS name**.

### 8.3 Log group (CloudWatch → Log groups → Create log group)

Name `/ecs/flowforge`, retention 1 week. The task definitions write to it.

### 8.4 Cluster (ECS → Clusters → Create cluster)

Name `flowforge`, infrastructure **AWS Fargate** only → Create.

### 8.5 Task definitions (ECS → Task definitions → Create new task definition → **Create new task definition with JSON**)

Open [deploy/aws/ecs/api-task-definition.json](../deploy/aws/ecs/api-task-definition.json) in your editor and use
find-and-replace on a copy:

| Find | Replace with |
|---|---|
| `<account-id>` | your account ID |
| `<region>` | your region, e.g. `ap-south-1` |
| `<secrets-manager-arn>` | the secret ARN from step 5 |
| `replaced-by-ci` | the image URI from step 6 |

Paste the result into the JSON editor → Create. Do the same with
[worker-task-definition.json](../deploy/aws/ecs/worker-task-definition.json).

### 8.6 Services (ECS → Clusters → flowforge → Services → Create)

**API service**

- Compute: **Launch type → FARGATE**
- Task definition family **`flowforge-api`**, latest revision. Service name `flowforge-api`, **Desired tasks: 2**
- Networking: default VPC, all subnets, security group **`flowforge-app`** only, **Public IP: On**
- Load balancing: **Application Load Balancer → Use an existing load balancer → `flowforge-alb`**,
  listener **80:HTTP**, **Use an existing target group → `flowforge-api`**, container `flowforge-api 3000:3000`
- Create

**Worker service**

- Same as the API service, but task definition **`flowforge-worker`**, name `flowforge-worker`, **Desired tasks: 5**,
  and **no load balancer**.

Wait until both services show all tasks **Running**, and the target group shows the 2 API targets as **healthy**.

`Public IP: On` lets tasks in the default VPC's public subnets pull from ECR and reach SQS without a NAT gateway.
A production setup would use private subnets with a NAT gateway or VPC endpoints.

**If a task stops right away:** open the stopped task and read **Stopped reason**, then check the logs in CloudWatch
(`/ecs/flowforge`). The usual causes are a placeholder that wasn't replaced, a missing log group, or the execution role
not being allowed to read the secret.

## 9. Test it on AWS

### 9.1 Smoke test (browser)

- `http://<alb-dns>/health` → `{"status":"ok","database":"ok","redis":"ok"}`
- `http://<alb-dns>/metrics` → `"workers": { "active": 50, ... }` once all 5 worker tasks are running
- CloudWatch → Log groups → `/ecs/flowforge` → a worker stream shows `worker.started` with `"queue":"sqs"`

### 9.2 Open the database to your IP (only for the test run)

The test scripts read PostgreSQL directly to compute their numbers.

- **RDS → flowforge-db → Modify → Connectivity → Public access: Publicly accessible → Apply immediately**
- **EC2 → Security Groups → flowforge-db → Edit inbound rules → Add rule: PostgreSQL, Source: My IP**

Then, in a terminal, from the repo:

```bash
cd app && npm ci
export API_URL=http://<alb-dns>
export DATABASE_URL="postgresql://flowforge:<db-password>@<rds-endpoint>:5432/flowforge?sslmode=no-verify"
```

### 9.3 End-to-end test

```bash
npm run test:e2e
```

It checks auth, DAG execution, concurrent idempotency, retries with backoff, the dead-letter list and replay,
non-retryable errors, rate-limit headers and metrics, all through the load balancer.

### 9.4 Load test (10,000 jobs, 50 workers)

The load test submits 2,000 runs as one user, so raise the rate limit first:
**ECS → Task definitions → flowforge-api → latest revision → Create new revision → container → Environment variables:
`RATE_LIMIT_MAX_REQUESTS = 100000` → Create**. Then **Services → flowforge-api → Update service → latest revision → Update**,
and wait for the deployment to finish.

```bash
RESULT_FILE=../docs/results/aws-load-test.json npm run test:load
```

While it runs, watch **SQS → flowforge-executions → Monitoring**: messages visible rises and falls as the workers drain the queue.

### 9.5 Failure-injection test

Start the test, and while it is running, go to **ECS → flowforge → Services → flowforge-worker → Tasks**, select
2 running tasks, and click **Stop**. Do this twice, about 10 seconds apart. The service replaces them automatically.

```bash
KILL_ROUNDS=0 RESULT_FILE=../docs/results/aws-failure-test.json npm run test:failure
```

(If you have the AWS CLI configured, `CHAOS=ecs ECS_CLUSTER=flowforge npm run test:failure` stops the tasks for you.)

Stopping a task in ECS sends SIGTERM, so this tests **graceful shutdown during a deploy or scale-in**: workers finish
their in-flight jobs before exiting, so expect few or no `LOST` attempts. The **hard-crash** case (SIGKILL) is what the
local Docker run covers. Both are worth describing in an interview.

### 9.6 SQS dead-letter queue

- **SQS → flowforge-executions → Send and receive messages → Message body `not-json` → Send**
- Wait about 3 minutes (5 receives × 30 s visibility timeout).
- **SQS → flowforge-executions-dlq → Send and receive messages → Poll for messages**: the `not-json` message is there.

### 9.7 Logs and metrics

**CloudWatch → Logs Insights**, log group `/ecs/flowforge`:

```text
fields @timestamp, event, jobId, step, attempt, error
| filter event in ["job.retry_scheduled", "job.dead_lettered", "execution.recovered_lost_jobs"]
| sort @timestamp desc
```

Also look at **ECS → flowforge-worker → Health and metrics** for CPU and memory, and **SQS → Monitoring** for queue depth.

### 9.8 Close everything again

- **RDS → flowforge-db → Modify → Public access: Not publicly accessible → Apply immediately**
- **Security group `flowforge-db`**: delete the My IP rule
- **flowforge-api**: create a task definition revision with `RATE_LIMIT_MAX_REQUESTS = 100` and update the service

**Take screenshots** of the running ECS services, the SQS graphs, Logs Insights and `/metrics`. They are good evidence
for "deployed on AWS" in an interview.

## 10. Turn on CI/CD (GitHub Actions → ECR → ECS)

After this, every push to `master` that passes the tests deploys automatically. GitHub signs in to AWS with OIDC,
so no AWS keys are stored in GitHub.

1. **IAM → Identity providers → Add provider → OpenID Connect**
   - Provider URL `https://token.actions.githubusercontent.com`, audience `sts.amazonaws.com` → Add
2. **IAM → Roles → Create role → Web identity**
   - Identity provider `token.actions.githubusercontent.com`, audience `sts.amazonaws.com`
   - GitHub organization `avinash-p05`, repository `flow-forge`, branch `master`
   - Skip managed policies, name it `flowforge-github-deploy` → Create
   - Open the role → **Add permissions → Create inline policy → JSON**:

   ```json
   {
     "Version": "2012-10-17",
     "Statement": [
       { "Effect": "Allow", "Action": "ecr:GetAuthorizationToken", "Resource": "*" },
       { "Effect": "Allow",
         "Action": ["ecr:BatchCheckLayerAvailability", "ecr:InitiateLayerUpload", "ecr:UploadLayerPart",
                    "ecr:CompleteLayerUpload", "ecr:PutImage", "ecr:BatchGetImage"],
         "Resource": "arn:aws:ecr:<region>:<account-id>:repository/flowforge" },
       { "Effect": "Allow",
         "Action": ["ecs:RegisterTaskDefinition", "ecs:DescribeTaskDefinition", "ecs:UpdateService", "ecs:DescribeServices"],
         "Resource": "*" },
       { "Effect": "Allow", "Action": "iam:PassRole",
         "Resource": ["arn:aws:iam::<account-id>:role/ecsTaskExecutionRole",
                      "arn:aws:iam::<account-id>:role/flowforge-api-task-role",
                      "arn:aws:iam::<account-id>:role/flowforge-worker-task-role"] }
     ]
   }
   ```

3. **GitHub → repo → Settings → Secrets and variables → Actions → Variables tab → New repository variable**:

| Variable | Value |
|---|---|
| `AWS_REGION` | e.g. `ap-south-1` |
| `AWS_ACCOUNT_ID` | your account ID |
| `AWS_DEPLOY_ROLE_ARN` | `arn:aws:iam::<account-id>:role/flowforge-github-deploy` |
| `ECR_REPOSITORY` | `flowforge` |
| `ECS_CLUSTER` | `flowforge` |
| `APP_SECRET_ARN` | the secret ARN from step 5 |

Push to `master` (or merge the PR) and open **Actions → CI/CD**. `test` runs first; `deploy` then pushes the image
tagged with the commit SHA and rolls both ECS services, waiting until they are stable.

## 11. Tear down (in this order)

1. **ECS → flowforge → Services**: update both services to **Desired tasks 0**, then **Delete** each
2. **ECS → Clusters → flowforge → Delete cluster**
3. **EC2 → Load balancers → flowforge-alb → Delete**, then **Target groups → flowforge-api → Delete**
4. **RDS → flowforge-db → Delete** (no final snapshot)
5. **ElastiCache → flowforge-redis → Delete**
6. **SQS** → delete both queues; **Secrets Manager** → delete `flowforge/app`; **ECR** → delete `flowforge`
7. After RDS and ElastiCache are gone (a few minutes): **EC2 → Security Groups** → delete the four `flowforge-*` groups
8. Optional: **IAM** → delete the roles and the GitHub identity provider; **CloudWatch** → delete `/ecs/flowforge`
