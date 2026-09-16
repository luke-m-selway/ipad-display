import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
	chmodSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

const bootstrap = 'scripts/bootstrap';

function makeFakeCommand(dir, name, body) {
	const path = join(dir, name);
	writeFileSync(path, `#!/bin/bash\n${body}\n`);
	chmodSync(path, 0o755);
}

function makeHarness({
	clt = true,
	arch = 'x86_64',
	macos = '13.7.8',
	existing = false,
	dirty = false,
	origin = 'https://github.com/luke-m-selway/ipad-display.git',
} = {}) {
	const root = mkdtempSync(join(tmpdir(), 'ipad-bootstrap-'));
	const fakeBin = join(root, 'bin');
	const repo = join(root, 'ipad-display');
	const log = join(root, 'calls.log');
	mkdirSync(fakeBin, { recursive: true });
	if (existing) mkdirSync(join(repo, '.git'), { recursive: true });

	makeFakeCommand(fakeBin, 'uname', `[[ "$1" == "-m" ]] && echo ${arch}`);
	makeFakeCommand(
		fakeBin,
		'sw_vers',
		`[[ "$1" == "-productVersion" ]] && echo ${macos}`,
	);
	makeFakeCommand(fakeBin, 'clang', 'exit 0');
	makeFakeCommand(
		fakeBin,
		'xcode-select',
		`if [[ "$1" == "-p" ]]; then ${clt ? 'echo /Library/Developer/CommandLineTools; exit 0' : 'exit 1'}; fi
if [[ "$1" == "--install" ]]; then echo "xcode-select --install" >> "$FAKE_LOG"; exit 0; fi
exit 1`,
	);
	makeFakeCommand(
		fakeBin,
		'git',
		`echo "git $*" >> "$FAKE_LOG"
if [[ "$1" == "clone" ]]; then
  target="${repo}"
  mkdir -p "$target/.git" "$target/scripts"
  cat > "$target/scripts/install" <<'INNER'
#!/bin/bash
echo "install $*" >> "$FAKE_LOG"
INNER
  chmod +x "$target/scripts/install"
  exit 0
fi
if [[ "$1" == "-C" ]]; then
  shift 2
  case "$1 $2" in
    "status --porcelain") ${dirty ? "echo ' M README.md'" : ':'}; exit 0 ;;
    "remote get-url") echo "${origin}"; exit 0 ;;
    "rev-parse HEAD"|"rev-parse origin/main") echo abc123; exit 0 ;;
  esac
  exit 0
fi
exit 0`,
	);

	if (existing) {
		mkdirSync(join(repo, 'scripts'), { recursive: true });
		writeFileSync(
			join(repo, 'scripts', 'install'),
			'#!/bin/bash\necho "install $*" >> "$FAKE_LOG"\n',
		);
		chmodSync(join(repo, 'scripts', 'install'), 0o755);
	}

	return {
		root,
		log,
		env: {
			...process.env,
			PATH: `${fakeBin}:/usr/bin:/bin`,
			HOME: root,
			IPAD_DISPLAY_REPO_DIR: repo,
			FAKE_LOG: log,
		},
	};
}

function run(harness, args = []) {
	return spawnSync('/bin/bash', [bootstrap, ...args], {
		encoding: 'utf8',
		env: harness.env,
	});
}

function calls(harness) {
	try {
		return readFileSync(harness.log, 'utf8');
	} catch {
		return '';
	}
}

test('missing Command Line Tools opens Apple installer and stops before clone', () => {
	const harness = makeHarness({ clt: false });
	try {
		const result = run(harness);
		assert.equal(result.status, 2);
		assert.match(result.stdout, /Opening Apple's installer/);
		assert.match(result.stdout, /rerun the same bootstrap command/);
		assert.match(calls(harness), /xcode-select --install/);
		assert.doesNotMatch(calls(harness), /git clone/);
	} finally {
		rmSync(harness.root, { recursive: true, force: true });
	}
});

test('fresh machine clones canonical repo and hands off without Homebrew', () => {
	const harness = makeHarness();
	try {
		const result = run(harness, ['--open-settings']);
		assert.equal(result.status, 0, result.stderr);
		assert.match(
			calls(harness),
			/git clone --branch main --single-branch https:\/\/github.com\/luke-m-selway\/ipad-display\.git/,
		);
		assert.match(calls(harness), /install --open-settings/);
		assert.match(result.stdout, /Homebrew is not required/);
	} finally {
		rmSync(harness.root, { recursive: true, force: true });
	}
});

test('existing dirty checkout is preserved and not updated', () => {
	const harness = makeHarness({ existing: true, dirty: true });
	try {
		const result = run(harness);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /has local changes/);
		assert.doesNotMatch(calls(harness), /git .*fetch/);
		assert.doesNotMatch(calls(harness), /install/);
	} finally {
		rmSync(harness.root, { recursive: true, force: true });
	}
});

test('existing canonical checkout fast-forwards and reinstalls', () => {
	const harness = makeHarness({ existing: true });
	try {
		const result = run(harness);
		assert.equal(result.status, 0, result.stderr);
		assert.match(calls(harness), /git .*remote get-url origin/);
		assert.match(calls(harness), /git .*fetch origin main/);
		assert.match(calls(harness), /git .*switch main/);
		assert.match(calls(harness), /git .*merge --ff-only origin\/main/);
		assert.match(calls(harness), /install/);
	} finally {
		rmSync(harness.root, { recursive: true, force: true });
	}
});

test('wrong existing origin is refused before fetch', () => {
	const harness = makeHarness({
		existing: true,
		origin: 'https://github.com/example/other.git',
	});
	try {
		const result = run(harness);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /does not point at the canonical/);
		assert.doesNotMatch(calls(harness), /git .*fetch/);
	} finally {
		rmSync(harness.root, { recursive: true, force: true });
	}
});

test('unsupported hardware fails before setup mutation', () => {
	const harness = makeHarness({ arch: 'arm64' });
	try {
		const result = run(harness);
		assert.equal(result.status, 1);
		assert.match(result.stderr, /Intel\/x86_64/);
		assert.equal(calls(harness), '');
	} finally {
		rmSync(harness.root, { recursive: true, force: true });
	}
});
