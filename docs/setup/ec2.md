# A clean EC2 box for OpenSession

You do not need AWS to run OpenSession — any Linux box works. This page exists
because "spin up a fresh VM" is the most common way people try it, and a couple
of traps along the way cost an afternoon each.

## Sizing

OpenSession runs agent turns, builds frontends and cuts git worktrees, so it
wants memory and disk more than cores.

| Use | Instance | Disk | IOPS / throughput |
| --- | --- | --- | --- |
| Trying it out | `t3.large` (2 vCPU, 8 GB) | 50 GB gp3 | default (3000 / 125) |
| A small team | `m7i-flex.xlarge` (4 vCPU, 16 GB) | 500 GB gp3 | 6000 / 500 |
| Heavy use, sandboxes, big repos | `m7i-flex.2xlarge`+ | 1 TB gp3 | 12000 / 1000 |

Worktrees and engine state grow steadily; disk is the resource that bites first.

**Set IOPS and throughput explicitly.** This is the non-obvious part of gp3: it
does *not* scale with capacity the way gp2 did. A 1 TB gp3 gets exactly the same
3,000 IOPS and 125 MB/s as an 8 GB one unless you ask for more. Everything
OpenSession does that feels slow — cloning repos, cutting worktrees, installing
dependencies, building frontends — is small-file I/O, and 125 MB/s is where it
goes to die.

The ceiling is 16,000 IOPS and 1,000 MB/s. You pay only for what you provision
above the baseline, so the "small team" row costs roughly $30/month more than
default and is the single cheapest thing you can do for how the box feels.

## Launch

Four steps, each printing what it resolved before the next one uses it. The AMI,
VPC and subnet are derived from whichever account and region your credentials
point at, so this works as-is. Step 2 is safe to re-run and step 3 refuses to
launch on missing input, because the two ways this goes wrong are re-running it
and launching a box you cannot log into.

None of these blocks contain `#` comments. That is deliberate — see
[the zsh trap](#the-zsh-trap) below.

**1. Resolve and check.**

```bash
KEY="$(cat ~/.ssh/id_ed25519.pub)"
MY_IP="$(curl -s https://checkip.amazonaws.com)/32"

AMI=$(aws ssm get-parameters \
  --names /aws/service/canonical/ubuntu/server/24.04/stable/current/amd64/hvm/ebs-gp3/ami-id \
  --query 'Parameters[0].Value' --output text)
VPC=$(aws ec2 describe-vpcs --filters Name=isDefault,Values=true \
  --query 'Vpcs[0].VpcId' --output text)
SUBNET=$(aws ec2 describe-subnets --filters Name=vpc-id,Values="$VPC" \
  --query 'Subnets[0].SubnetId' --output text)

echo "account=$(aws sts get-caller-identity --query Account --output text)"
echo "region=$(aws configure get region)"
echo "vpc=$VPC  subnet=$SUBNET  ami=$AMI"
echo "from=$MY_IP  key=${KEY%% *} ${#KEY} chars"
```

Read that output before continuing. Wrong account or region is the expensive
mistake; an empty `key=` is the annoying one.

**2. Security group, safe to re-run.**

```bash
SG=$(aws ec2 describe-security-groups --filters \
  Name=group-name,Values=opensession Name=vpc-id,Values="$VPC" \
  --query 'SecurityGroups[0].GroupId' --output text 2>/dev/null)

if [ -z "$SG" ] || [ "$SG" = None ]; then
  SG=$(aws ec2 create-security-group --group-name opensession \
    --description "OpenSession" --vpc-id "$VPC" --query GroupId --output text)
fi

aws ec2 authorize-security-group-ingress --group-id "$SG" \
  --protocol tcp --port 22 --cidr "$MY_IP" >/dev/null 2>&1

echo "sg=$SG"
```

Reuses the group if it exists and adds your current IP if it is not already
allowed. The suppressed error is the harmless duplicate-rule one; run it again
from a new network and you get a second rule rather than a failure.

**3. Launch, guarded.**

```bash
if [ -z "$KEY" ] || [ -z "$SG" ] || [ "$SG" = None ] || [ "$SUBNET" = None ]; then
  echo "refusing to launch: one of KEY, SG, SUBNET is unset"
else
  ID=$(aws ec2 run-instances \
    --image-id "$AMI" --instance-type m7i-flex.xlarge \
    --subnet-id "$SUBNET" --security-group-ids "$SG" \
    --associate-public-ip-address \
    --metadata-options "HttpTokens=required" \
    --block-device-mappings '[{"DeviceName":"/dev/sda1","Ebs":{"VolumeSize":500,"VolumeType":"gp3","Iops":6000,"Throughput":500,"DeleteOnTermination":true,"Encrypted":true}}]' \
    --tag-specifications 'ResourceType=instance,Tags=[{Key=Name,Value=opensession}]' \
    --user-data "#cloud-config
ssh_authorized_keys:
  - $KEY" \
    --query 'Instances[0].InstanceId' --output text)
  echo "instance=$ID"
fi
```

The guard is the whole point: user-data runs once, at first boot. An instance
launched with an empty key cannot be repaired, only replaced.

**4. Wait for it.**

```bash
aws ec2 wait instance-running --instance-ids "$ID"
IP=$(aws ec2 describe-instances --instance-ids "$ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
echo "ip=$IP"

for i in 1 2 3 4 5 6 7 8 9 10; do
  ssh -o ConnectTimeout=5 -o StrictHostKeyChecking=accept-new \
    ubuntu@"$IP" true 2>/dev/null && break
  sleep 10
done
ssh ubuntu@"$IP" true && echo "ssh ok" || echo "ssh still failing"
```

`instance-running` fires well before cloud-init has installed your key, so the
first few attempts failing is normal. If it is still failing after the loop,
the key never landed — see the traps below.

### The zsh trap

Every block above is comment-free because zsh does not enable comments in
interactive shells by default (`interactivecomments` is off). Paste this:

```bash
KEY="$(cat ~/.ssh/id_ed25519.pub)"        # the key you will SSH in with
```

and zsh parses `#` as the command, with `KEY=...` as a one-shot environment
prefix for it. You get `zsh: command not found: #` — which looks cosmetic and
scrolls away — and `$KEY` is **empty in your shell**. The launch then succeeds
with an empty `ssh_authorized_keys` entry, and twenty lines later SSH says
`Permission denied (publickey)` for no visible reason.

Same shape bites any `VAR=... # comment` line. Either keep comments on their own
line, or `setopt interactivecomments` first.

### The cloud-init trap

Note the user-data above uses the **top-level `ssh_authorized_keys` module**.
The obvious-looking alternative is wrong:

```yaml
# DO NOT DO THIS
#cloud-config
users:
  - name: ubuntu
    ssh_authorized_keys: ["ssh-ed25519 ..."]
```

A `users:` list *replaces* cloud-init's default user definition. The default
carries `sudo: ALL=(ALL) NOPASSWD:ALL` and the standard group memberships, so
redefining `ubuntu` silently strips both. You get a box you can SSH into and
then cannot `sudo` on — `/etc/sudoers.d/` will contain only `README`, and `id`
will show `groups=1000(ubuntu)` and nothing else.

The failure shows up much later, as an unrelated-looking permissions error
while installing a package. If you hit it, the fix is to relaunch — you cannot
grant yourself sudo without sudo.

If you do want to declare users explicitly, keep the default:

```yaml
#cloud-config
users:
  - default
  - name: someone-else
    sudo: ALL=(ALL) NOPASSWD:ALL
```

## Install

```bash
ssh ubuntu@<address>
curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash
```

Then follow [install.md](install.md) for accounts and integrations.

## Networking

The security group above opens **only** port 22, and only to your current IP.
Nothing else about this box is reachable, which is the correct starting point:
OpenSession has no built-in authentication and trusts everyone who can reach
the address it binds to.

Deciding how to reach the UI — Tailscale, an SSH tunnel, a custom domain — is
the same problem on EC2 as anywhere else, so it lives in one place:
**[networking.md](networking.md)**. Read it before changing `HOST`.

The one EC2-specific note: do not add 3850 to this security group.

## SSH in to debug

The box stays a normal Linux box — SSH in whenever you want to inspect or
test something. Nothing about the install hides state from you:

```bash
ssh ubuntu@<address>
```

| Command | What |
| --- | --- |
| `opensession status` | is it running? |
| `opensession doctor` | what is wrong |
| `opensession logs -f` | follow the service journal |
| `opensession version` | which commit is deployed |

Useful paths:

| Path | What |
| --- | --- |
| `~/.opensession/src` | the checkout — a normal git repo, edit it |
| `~/.opensession/config.json` | instance config (re-read on change) |
| `~/.opensession.env` | secrets, loaded by the service |
| `~/.opensession-chats/` | session store |
| `~/worktrees/` | per-session git worktrees |

To run it in the foreground and watch it directly:

```bash
opensession stop
opensession start --foreground
```

Frontend edits rebuild live. Backend edits need `opensession restart`.

## Outgrowing the box

Both of these are things you will want eventually, and they are very different
operations: **disk grows online, instance type does not.**

### More disk, no reboot

EBS resizes live. You grow the volume, then grow the partition, then grow the
filesystem — all with the box running and OpenSession serving.

From your laptop:

```bash
VOL=$(aws ec2 describe-instances --instance-ids "$ID" \
  --query 'Reservations[0].Instances[0].BlockDeviceMappings[0].Ebs.VolumeId' \
  --output text)
echo "volume=$VOL"

aws ec2 modify-volume --volume-id "$VOL" --size 1000 --iops 12000 --throughput 1000

aws ec2 describe-volumes-modifications --volume-ids "$VOL" \
  --query 'VolumesModifications[0].{State:ModificationState,Progress:Progress}' \
  --output table
```

Wait for the state to reach `optimizing` — that is enough, you do not need
`completed`. Then on the box:

```bash
lsblk
sudo growpart /dev/nvme0n1 1
sudo resize2fs /dev/nvme0n1p1
df -h /
```

`lsblk` first, always: the root device name is not guaranteed. On Nitro
instances it is `nvme0n1` with root on partition 1, but confirm rather than
assume. Note the space in `growpart /dev/nvme0n1 1` — device and partition
number are separate arguments, unlike `resize2fs`, which takes the partition.

Three things that catch people out:

- **You cannot shrink.** Growing is one-way. Oversizing costs a few dollars a
  month; undersizing costs a rebuild.
- **One modification per volume per 6 hours.** Plan the size you want rather
  than creeping up 100 GB at a time.
- `--iops` and `--throughput` are optional here, but a bigger volume with the
  old 125 MB/s is a common half-fix. Raise them in the same call.

### A bigger instance, with a stop

Instance type is fixed while running. This one has downtime:

```bash
aws ec2 stop-instances --instance-ids "$ID"
aws ec2 wait instance-stopped --instance-ids "$ID"

aws ec2 modify-instance-attribute --instance-id "$ID" \
  --instance-type '{"Value":"m7i-flex.2xlarge"}'

aws ec2 start-instances --instance-ids "$ID"
aws ec2 wait instance-running --instance-ids "$ID"
```

Roughly two minutes of downtime. The root volume and everything on it survives
untouched — `~/.opensession`, your config, secrets, sessions and worktrees are
all on it. systemd brings the service back on boot, so:

```bash
ssh ubuntu@"$IP"
opensession status
```

**The public IP changes.** A stop/start releases the auto-assigned public
address and you get a new one on boot. Anything pinned to the old address —
your `~/.ssh/config`, a DNS record, `OPENSESSION_UI_BASE`, a webhook URL you
registered with GitHub or Linear — is now pointing at nothing.

If you have not pinned the address, re-fetch it after every start:

```bash
IP=$(aws ec2 describe-instances --instance-ids "$ID" \
  --query 'Reservations[0].Instances[0].PublicIpAddress' --output text)
echo "ip=$IP"
```

### A stable address

Two different problems, two different answers — and they are not alternatives,
most setups want both.

**For reaching the UI: Tailscale.** The tailnet address is a property of the
machine, not of the lease, so it survives stop/start for free and is not public
in the first place. If the UI is all you need to reach, you do not need an
Elastic IP at all. See [networking.md](networking.md).

**For inbound webhooks: an Elastic IP.** GitHub, Linear, Plain, Slack and
Stripe deliver *to* you, from the public internet, at a URL you registered with
them once. A changed IP silently breaks every one of those registrations, and
the symptom is not an error — it is automations that quietly stop firing.

```bash
ALLOC=$(aws ec2 allocate-address --domain vpc --query AllocationId --output text)
aws ec2 associate-address --instance-id "$ID" --allocation-id "$ALLOC"

IP=$(aws ec2 describe-addresses --allocation-ids "$ALLOC" \
  --query 'Addresses[0].PublicIp' --output text)
echo "eip=$IP  allocation=$ALLOC"
```

Note `$ALLOC` — you need it to release the address later, and it is far easier
to save now than to hunt for at teardown.

The address changes **once**, at association, and then never again. Point your
DNS record at it after this, not before.

Three things worth knowing:

- **It is not free, and has not been since 2024.** Every public IPv4 address
  costs about $0.005/hour (~$3.60/month) whether or not it is attached. The old
  rule — free while associated, charged while idle — no longer applies.
- **Allocated is billed, associated or not.** An Elastic IP you allocated for a
  box you have since terminated keeps charging until you release it.
- **Release it at teardown**, or it outlives the instance on your bill.

Only allocate one if something actually needs to reach you from the public
internet. For a Tailscale-only install, skip it.

## Updating

```bash
opensession update
opensession update --check
```

`update` fast-forwards, reinstalls dependencies and restarts. `--check` shows
what would change and does nothing.

Fast-forward only: if you have local commits or uncommitted edits, it stops and
tells you rather than rewriting your work.

## Tearing it down

```bash
aws ec2 terminate-instances --instance-ids "$ID"
aws ec2 wait instance-terminated --instance-ids "$ID"
aws ec2 delete-security-group --group-id "$SG"
aws ec2 release-address --allocation-id "$ALLOC"
```

The `wait` matters: the security group cannot be deleted while anything is
still attached to it, and a terminating instance counts.

Skip the last line if you never allocated an Elastic IP — and do not skip it if
you did. A released instance stops costing money immediately; an Elastic IP you
forgot to release keeps billing indefinitely, which is the classic way to
discover you left something running months later.

The root volume is `DeleteOnTermination`, so nothing is left behind. To remove
an install without destroying the box:

```bash
curl -fsSL https://raw.githubusercontent.com/tellahq/opensession/main/install.sh | bash -s -- --uninstall
```

That stops and removes the service and the `opensession` command, and leaves
your config, secrets and sessions in place — it tells you where they are.
