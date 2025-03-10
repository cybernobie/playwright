/**
 * Copyright (c) Microsoft Corporation.
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

import * as fs from 'fs';

import { spawnAsync } from 'playwright-core/lib/utils';

import type { TestRunnerPlugin } from './';
import type { FullConfig } from '../../types/testReporter';
import type { FullConfigInternal } from '../common/config';
import type { GitCommitInfo, CIInfo, UserMetadataWithCommitInfo } from '../isomorphic/types';

const GIT_OPERATIONS_TIMEOUT_MS = 3000;

export const addGitCommitInfoPlugin = (fullConfig: FullConfigInternal) => {
  fullConfig.plugins.push({ factory: gitCommitInfoPlugin });
};

type GitCommitInfoPluginOptions = {
  directory?: string;
};

export const gitCommitInfoPlugin = (options?: GitCommitInfoPluginOptions): TestRunnerPlugin => {
  return {
    name: 'playwright:git-commit-info',

    setup: async (config: FullConfig, configDir: string) => {
      const metadata = config.metadata as UserMetadataWithCommitInfo;
      const ci = await ciInfo();
      if (!metadata.ci && ci)
        metadata.ci = ci;

      if ((ci && !metadata.gitCommit) || metadata.gitCommit === 'generate') {
        const git = await gitCommitInfo(options?.directory || configDir).catch(e => {
          // eslint-disable-next-line no-console
          console.error('Failed to get git commit info', e);
        });
        if (git)
          metadata.gitCommit = git;
      }

      if ((ci && !metadata.gitDiff) || metadata.gitDiff === 'generate') {
        const diffResult = await gitDiff(options?.directory || configDir, ci).catch(e => {
          // eslint-disable-next-line no-console
          console.error('Failed to get git diff', e);
        });
        if (diffResult)
          metadata.gitDiff = diffResult;
      }
    },
  };
};

async function ciInfo(): Promise<CIInfo | undefined> {
  if (process.env.GITHUB_ACTIONS) {
    let pr: { title: string, number: number } | undefined;
    try {
      const json = JSON.parse(await fs.promises.readFile(process.env.GITHUB_EVENT_PATH!, 'utf8'));
      pr = { title: json.pull_request.title, number: json.pull_request.number };
    } catch {
    }

    return {
      commitHref: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/commit/${process.env.GITHUB_SHA}`,
      prHref: pr ? `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/pull/${pr.number}` : undefined,
      prTitle: pr ? pr.title : undefined,
      buildHref: `${process.env.GITHUB_SERVER_URL}/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}`,
      commitHash: process.env.GITHUB_SHA,
      baseHash: process.env.GITHUB_BASE_REF,
      branch: process.env.GITHUB_REF_NAME,
    };
  }

  if (process.env.GITLAB_CI) {
    return {
      commitHref: `${process.env.CI_PROJECT_URL}/-/commit/${process.env.CI_COMMIT_SHA}`,
      prHref: process.env.CI_MERGE_REQUEST_IID ? `${process.env.CI_PROJECT_URL}/-/merge_requests/${process.env.CI_MERGE_REQUEST_IID}` : undefined,
      buildHref: process.env.CI_JOB_URL,
      commitHash: process.env.CI_COMMIT_SHA,
      baseHash: process.env.CI_COMMIT_BEFORE_SHA,
      branch: process.env.CI_COMMIT_REF_NAME,
    };
  }

  if (process.env.JENKINS_URL && process.env.BUILD_URL) {
    return {
      commitHref: process.env.BUILD_URL,
      commitHash: process.env.GIT_COMMIT,
      baseHash: process.env.GIT_PREVIOUS_COMMIT,
      branch: process.env.GIT_BRANCH,
    };
  }

  // Open to PRs.
}

async function gitCommitInfo(gitDir: string): Promise<GitCommitInfo | undefined> {
  const separator = `---786eec917292---`;
  const tokens = [
    '%H',  // commit hash
    '%h',  // abbreviated commit hash
    '%s',  // subject
    '%B',  // raw body (unwrapped subject and body)
    '%an', // author name
    '%ae', // author email
    '%at', // author date, UNIX timestamp
    '%cn', // committer name
    '%ce', // committer email
    '%ct', // committer date, UNIX timestamp
    '',    // branch
  ];
  const commitInfoResult = await spawnAsync(
      `git log -1 --pretty=format:"${tokens.join(separator)}" && git rev-parse --abbrev-ref HEAD`, [],
      { stdio: 'pipe', cwd: gitDir, timeout: GIT_OPERATIONS_TIMEOUT_MS, shell: true }
  );
  if (commitInfoResult.code)
    return undefined;
  const showOutput = commitInfoResult.stdout.trim();
  const [hash, shortHash, subject, body, authorName, authorEmail, authorTime, committerName, committerEmail, committerTime, branch] = showOutput.split(separator);

  return {
    shortHash,
    hash,
    subject,
    body,
    author: {
      name: authorName,
      email: authorEmail,
      time: +authorTime * 1000,
    },
    committer: {
      name: committerName,
      email: committerEmail,
      time: +committerTime * 1000,
    },
    branch: branch.trim(),
  };
}

async function gitDiff(gitDir: string, ci?: CIInfo): Promise<string | undefined> {
  const diffLimit = 100_000;
  const baseHash = ci?.baseHash ?? 'HEAD~1';

  const pullDiffResult = await spawnAsync(
      'git',
      ['diff', baseHash],
      { stdio: 'pipe', cwd: gitDir, timeout: GIT_OPERATIONS_TIMEOUT_MS }
  );
  if (!pullDiffResult.code)
    return pullDiffResult.stdout.substring(0, diffLimit);
}
