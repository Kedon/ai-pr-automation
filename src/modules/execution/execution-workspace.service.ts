import { Injectable } from '@nestjs/common';
import { dirname, join, normalize, relative } from 'node:path';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';

const execFileAsync = promisify(execFile);

export interface WorkspaceSnapshot {
  repoDir: string;
  fileList: string[];
  packageJson: string | null;
  readme: string | null;
  branchName: string;
  baseBranch: string;
}

@Injectable()
export class ExecutionWorkspaceService {
  private readonly defaultCommandTimeoutMs = Number(
    process.env.WORKSPACE_COMMAND_TIMEOUT_MS ?? 180000,
  );
  private readonly installEnabled = process.env.WORKSPACE_INSTALL_ENABLED?.trim() === 'true';

  async prepareSnapshot(input: {
    owner: string;
    repo: string;
    baseBranch: string;
    branchName: string;
  }): Promise<WorkspaceSnapshot> {
    const token = process.env.GITHUB_TOKEN?.trim();
    if (!token) {
      throw new Error('GITHUB_TOKEN is not configured.');
    }

    const repoDir = await mkdtemp(join(tmpdir(), 'ai-pr-codex-'));
    const remoteUrl = `https://x-access-token:${token}@github.com/${input.owner}/${input.repo}.git`;

    await this.runGit(['clone', remoteUrl, repoDir], tmpdir());
    await this.runGit(['checkout', input.baseBranch], repoDir);

    const remoteBranchExists = await this.remoteBranchExists(repoDir, input.branchName);
    if (remoteBranchExists) {
      await this.runGit(['checkout', '-B', input.branchName, `origin/${input.branchName}`], repoDir);
    } else {
      await this.runGit(['checkout', '-B', input.branchName, `origin/${input.baseBranch}`], repoDir);
    }

    const fileList = await this.listTrackedFiles(repoDir);
    const packageJson = await this.safeRead(join(repoDir, 'package.json'));
    const readme =
      (await this.safeRead(join(repoDir, 'README.md'))) ??
      (await this.safeRead(join(repoDir, 'readme.md')));

    if (this.installEnabled) {
      await this.installProjectDependencies(repoDir, packageJson, fileList);
    }

    return {
      repoDir,
      fileList,
      packageJson,
      readme,
      branchName: input.branchName,
      baseBranch: input.baseBranch,
    };
  }

  async cleanup(snapshot: WorkspaceSnapshot | null): Promise<void> {
    if (!snapshot) {
      return;
    }

    await rm(snapshot.repoDir, { recursive: true, force: true });
  }

  async listFiles(repoDir: string, dirPath = '.'): Promise<string[]> {
    const absolute = this.resolveSafePath(repoDir, dirPath);
    const entries = await readdir(absolute, { withFileTypes: true });

    return entries
      .map((entry) => `${dirPath === '.' ? '' : `${dirPath}/`}${entry.name}`.replace(/^\/+/, ''))
      .sort()
      .slice(0, 200);
  }

  async readWorkspaceFile(repoDir: string, filePath: string): Promise<string> {
    const absolute = this.resolveSafePath(repoDir, filePath);
    const contents = await readFile(absolute, 'utf8');
    return contents.slice(0, 20000);
  }

  async writeWorkspaceFile(repoDir: string, filePath: string, content: string): Promise<void> {
    const absolute = this.resolveSafePath(repoDir, filePath);
    await mkdir(dirname(absolute), { recursive: true });
    await writeFile(absolute, content, 'utf8');
  }

  async runAllowedCommand(repoDir: string, command: string): Promise<string> {
    const normalized = command.trim();
    const allowedPrefixes = [
      'npm test',
      'npm run test',
      'npm run build',
      'npm run lint',
      'npm install',
      'npm install --save-dev @babel/plugin-proposal-private-property-in-object',
      'npx update-browserslist-db@latest',
      'git status --short',
      'git diff --stat',
      'git diff --',
      'pnpm test',
      'pnpm run test',
      'pnpm run build',
      'pnpm run lint',
      'pnpm install',
      'pnpm add -D @babel/plugin-proposal-private-property-in-object',
      'pnpm exec update-browserslist-db',
      'yarn test',
      'yarn build',
      'yarn lint',
      'yarn install',
      'yarn add -D @babel/plugin-proposal-private-property-in-object',
      'yarn dlx update-browserslist-db',
    ];

    if (!allowedPrefixes.some((prefix) => normalized.startsWith(prefix))) {
      throw new Error(`Command "${command}" is not allowed in Codex workspace execution.`);
    }

    const shell = process.platform === 'win32' ? 'powershell' : 'sh';
    const args =
      process.platform === 'win32'
        ? ['-NoProfile', '-Command', normalized]
        : ['-lc', normalized];

    const { stdout, stderr } = await execFileAsync(shell, args, {
      cwd: repoDir,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 4,
      timeout: this.defaultCommandTimeoutMs,
    }).catch((error: { stdout?: string; stderr?: string; message?: string; signal?: string }) => {
      const output = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n').trim();
      const signalSuffix = error.signal ? `\nSignal: ${error.signal}` : '';
      throw new Error(
        `Command failed: ${normalized}\n${output || 'No command output captured.'}${signalSuffix}`.trim(),
      );
    });

    return [stdout, stderr].filter(Boolean).join('\n').slice(0, 20000);
  }

  async searchWorkspace(repoDir: string, query: string): Promise<string> {
    const normalized = query.trim();
    if (!normalized) {
      throw new Error('Search query cannot be empty.');
    }

    const { stdout } = await execFileAsync(
      'git',
      ['grep', '-n', '-I', '--full-name', '-F', normalized, '--', '.'],
      {
        cwd: repoDir,
        windowsHide: true,
        maxBuffer: 1024 * 1024 * 4,
      },
    ).catch((error: { code?: number; stdout?: string; stderr?: string }) => {
      if (error.code === 1) {
        return { stdout: '', stderr: '' };
      }

      throw error;
    });

    return stdout.slice(0, 20000);
  }

  async getGitDiff(repoDir: string): Promise<string> {
    const { stdout } = await execFileAsync('git', ['diff', '--', '.'], {
      cwd: repoDir,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 4,
    });

    return stdout.slice(0, 30000);
  }

  async hasChanges(repoDir: string): Promise<boolean> {
    const { stdout } = await execFileAsync('git', ['status', '--porcelain'], {
      cwd: repoDir,
      windowsHide: true,
    });

    return stdout.trim().length > 0;
  }

  async commitAndPush(input: {
    repoDir: string;
    branchName: string;
    commitMessage: string;
  }): Promise<void> {
    await this.runGit(
      ['config', 'user.name', process.env.GIT_AUTHOR_NAME?.trim() || 'AI PR Automation'],
      input.repoDir,
    );
    await this.runGit(
      ['config', 'user.email', process.env.GIT_AUTHOR_EMAIL?.trim() || 'ai-pr-automation@example.com'],
      input.repoDir,
    );
    await this.runGit(['add', '.'], input.repoDir);
    await this.runGit(['commit', '-m', input.commitMessage], input.repoDir);
    await this.runGit(['push', '--set-upstream', 'origin', input.branchName], input.repoDir);
  }

  private async listTrackedFiles(repoDir: string): Promise<string[]> {
    const { stdout } = await execFileAsync('git', ['ls-files'], {
      cwd: repoDir,
      windowsHide: true,
    });

    return stdout
      .split(/\r?\n/)
      .map((file) => file.trim())
      .filter(Boolean)
      .slice(0, 250);
  }

  private async remoteBranchExists(repoDir: string, branchName: string): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync('git', ['ls-remote', '--heads', 'origin', branchName], {
        cwd: repoDir,
        windowsHide: true,
      });

      return stdout.trim().length > 0;
    } catch {
      return false;
    }
  }

  private async safeRead(filePath: string): Promise<string | null> {
    try {
      const contents = await readFile(filePath, 'utf8');
      return contents.slice(0, 8000);
    } catch {
      return null;
    }
  }

  private async installProjectDependencies(
    repoDir: string,
    packageJson: string | null,
    fileList: string[],
  ): Promise<void> {
    if (!packageJson) {
      return;
    }

    const installCommand = this.getInstallCommand(packageJson, fileList);
    if (!installCommand) {
      return;
    }

    const shell = process.platform === 'win32' ? 'powershell' : 'sh';
    const args =
      process.platform === 'win32'
        ? ['-NoProfile', '-Command', installCommand]
        : ['-lc', installCommand];

    await execFileAsync(shell, args, {
      cwd: repoDir,
      windowsHide: true,
      maxBuffer: 1024 * 1024 * 8,
      timeout: Number(process.env.WORKSPACE_INSTALL_TIMEOUT_MS ?? 300000),
    }).catch((error: { stdout?: string; stderr?: string; message?: string }) => {
      const output = [error.stdout, error.stderr, error.message].filter(Boolean).join('\n');
      throw new Error(
        `Failed to install project dependencies before Codex execution.\nCommand: ${installCommand}\n${output}`.trim(),
      );
    });
  }

  private getInstallCommand(packageJson: string, fileList: string[]): string | null {
    const packageManager = this.detectPackageManager(packageJson, fileList);

    if (packageManager === 'pnpm') {
      return 'pnpm install --frozen-lockfile';
    }

    if (packageManager === 'yarn') {
      return 'yarn install --frozen-lockfile';
    }

    if (fileList.includes('package-lock.json')) {
      return 'npm ci';
    }

    return 'npm install --no-fund --no-audit';
  }

  getValidationRepairCommands(packageManager: 'npm' | 'pnpm' | 'yarn'): string[] {
    if (packageManager === 'pnpm') {
      return [
        'pnpm exec update-browserslist-db',
        'pnpm install',
        'pnpm add -D @babel/plugin-proposal-private-property-in-object',
      ];
    }

    if (packageManager === 'yarn') {
      return [
        'yarn dlx update-browserslist-db',
        'yarn install',
        'yarn add -D @babel/plugin-proposal-private-property-in-object',
      ];
    }

    return [
      'npx update-browserslist-db@latest',
      'npm install --no-fund --no-audit',
      'npm install --save-dev @babel/plugin-proposal-private-property-in-object',
    ];
  }

  private detectPackageManager(packageJson: string, fileList: string[]): 'npm' | 'pnpm' | 'yarn' {
    try {
      const parsed = JSON.parse(packageJson) as {
        packageManager?: string;
      };
      const packageManager = parsed.packageManager?.toLowerCase() ?? '';

      if (packageManager.startsWith('pnpm')) {
        return 'pnpm';
      }

      if (packageManager.startsWith('yarn')) {
        return 'yarn';
      }
    } catch {
      // ignore invalid package.json metadata
    }

    if (fileList.includes('pnpm-lock.yaml')) {
      return 'pnpm';
    }

    if (fileList.includes('yarn.lock')) {
      return 'yarn';
    }

    return 'npm';
  }

  private resolveSafePath(repoDir: string, targetPath: string): string {
    const normalizedTarget = normalize(targetPath).replace(/^(\.\.(\/|\\|$))+/, '');
    const absolute = join(repoDir, normalizedTarget);
    const relativePath = relative(repoDir, absolute);

    if (relativePath.startsWith('..') || normalize(relativePath).startsWith('..')) {
      throw new Error(`Path "${targetPath}" is outside the allowed workspace.`);
    }

    return absolute;
  }

  private async runGit(args: string[], cwd: string): Promise<void> {
    await execFileAsync('git', args, {
      cwd,
      windowsHide: true,
    });
  }
}
