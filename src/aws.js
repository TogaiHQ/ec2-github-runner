const AWS = require('aws-sdk');
const core = require('@actions/core');
const config = require('./config');

// User data scripts are run as the root user
function buildUserDataScript(githubRegistrationToken, label) {
  const binBash = '#!/bin/bash'
  const configureRunner = `./config.sh --url https://github.com/${config.githubContext.owner}/${config.githubContext.repo} --token ${githubRegistrationToken} --labels ${label} --name $(hostname)-$(uuidgen) --replace --ephemeral --unattended`
  const createPreRunnerScript = `echo "${config.input.preRunnerScript}" > pre-runner-script.sh`
  const runPreRunnerScript = 'source pre-runner-script.sh'
  const allowRunAsRoot = 'export RUNNER_ALLOW_RUNASROOT=1'
  const installTheRunnerSystemdService = './svc.sh install'
  const runTheRunnerSystemdService = './svc.sh start'
  const findMachineArchitecture = 'case $(uname -m) in aarch64) ARCH="arm64" ;; amd64|x86_64) ARCH="x64" ;; esac && export RUNNER_ARCH=${ARCH}'
  const runnerVersion = '2.307.1'
  const downloadRunnerTarBall = `curl -O -L https://github.com/actions/runner/releases/download/v${runnerVersion}/actions-runner-linux-\${RUNNER_ARCH}-${runnerVersion}.tar.gz`

  if (config.input.runnerHomeDir) {
    // If runner home directory is specified, we expect the actions-runner software (and dependencies)
    // to be pre-installed in the AMI, so we simply cd into that directory and then start the runner
    return [
      binBash,
      `cd "${config.input.runnerHomeDir}"`,
      createPreRunnerScript,
      runPreRunnerScript,
      allowRunAsRoot,
      configureRunner,
      installTheRunnerSystemdService,
      runTheRunnerSystemdService,
    ];
  } else {
    return [
      binBash,
      'mkdir actions-runner && cd actions-runner',
      createPreRunnerScript,
      runPreRunnerScript,
      findMachineArchitecture,
      downloadRunnerTarBall,
      'tar xzf ./actions-runner-linux-${RUNNER_ARCH}-2.299.1.tar.gz',
      allowRunAsRoot,
      configureRunner,
      installTheRunnerSystemdService,
      runTheRunnerSystemdService,
    ];
  }
}

async function startEc2Instance(label, githubRegistrationToken) {
  const ec2 = new AWS.EC2();

  const userData = buildUserDataScript(githubRegistrationToken, label);

  const params = {
    ImageId: config.input.ec2ImageId,
    InstanceType: config.input.ec2InstanceType,
    MinCount: 1,
    MaxCount: 1,
    UserData: Buffer.from(userData.join('\n')).toString('base64'),
    IamInstanceProfile: { Name: config.input.iamRoleName },
    TagSpecifications: config.tagSpecifications,
    NetworkInterfaces: [
      {
        AssociatePublicIpAddress: config.input.assignPublicIpToInstance,
        DeviceIndex: 0,
        SubnetId: config.input.subnetId,
        Groups: [config.input.securityGroupId] // security groups
      }
    ]
  };

  if (!!config.input.keyName) {
    params.KeyName = config.input.keyName
  }

  if (config.input.isSpotInstance) {
    params.InstanceMarketOptions = {
      MarketType: 'spot',
      SpotOptions: {
        SpotInstanceType: 'one-time',
        InstanceInterruptionBehavior: 'terminate'
      }
    }
  }

  core.debug(`RunInstances parameters: ${JSON.stringify(params)}`)

  try {
    const result = await ec2.runInstances(params).promise();
    const ec2InstanceId = result.Instances[0].InstanceId;
    core.info(`AWS EC2 instance ${ec2InstanceId} is started`);
    return ec2InstanceId;
  } catch (error) {
    core.error('AWS EC2 instance starting error');
    throw error;
  }
}

async function terminateEc2Instance() {
  const ec2 = new AWS.EC2();

  const params = {
    InstanceIds: [config.input.ec2InstanceId],
  };

  try {
    await ec2.terminateInstances(params).promise();
    core.info(`AWS EC2 instance ${config.input.ec2InstanceId} is terminated`);
    return;
  } catch (error) {
    core.error(`AWS EC2 instance ${config.input.ec2InstanceId} termination error`);
    throw error;
  }
}

async function waitForInstanceRunning(ec2InstanceId) {
  const ec2 = new AWS.EC2();

  const params = {
    InstanceIds: [ec2InstanceId],
  };

  try {
    await ec2.waitFor('instanceRunning', params).promise();
    core.info(`AWS EC2 instance ${ec2InstanceId} is up and running`);
    return;
  } catch (error) {
    core.error(`AWS EC2 instance ${ec2InstanceId} initialization error`);
    throw error;
  }
}

module.exports = {
  startEc2Instance,
  terminateEc2Instance,
  waitForInstanceRunning,
};
