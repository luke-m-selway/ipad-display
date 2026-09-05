import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { IpadInput } from './lifecycleRuntime';

export type VirtualDisplayBounds = {
	x: number;
	y: number;
	width: number;
	height: number;
};

const defaultHelperPath = join(
	homedir(),
	'.local/lib/ipad-display/ipad-input-helper',
);

/** Owns one helper and one held-button state for the active touch host. */
export class IpadInputBridge {
	private child: ChildProcessWithoutNullStreams | null = null;
	private buttonHeld = false;

	constructor(
		private readonly bounds: VirtualDisplayBounds,
		private readonly helperPath = defaultHelperPath,
	) {}

	start(): void {
		if (this.child) return;
		this.child = spawn(this.helperPath, [], { stdio: 'pipe' });
		this.child.on('error', (error) => {
			console.error('[iPad Input] Helper failed to start', error);
			this.child = null;
		});
		this.child.stderr.on('data', (data) => {
			console.log(`[iPad Input] ${String(data).trim()}`);
		});
		this.child.on('exit', (code, signal) => {
			console.log(`[iPad Input] Helper exited code=${code} signal=${signal}`);
			this.child = null;
			this.buttonHeld = false;
		});
	}

	stop(): void {
		this.release();
		this.child?.stdin.end();
		this.child = null;
	}

	release(): void {
		if (!this.buttonHeld) return;
		this.write('release');
		this.buttonHeld = false;
	}

	handle(input: IpadInput): void {
		switch (input.action) {
			case 'mission_control':
			case 'space_left':
			case 'space_right':
				this.release();
				this.write(input.action);
				return;
		}
		const position = this.position(input.x, input.y);
		switch (input.action) {
			case 'move':
				this.write(`move ${position}`);
				return;
			case 'click':
				this.release();
				this.write(`click ${position}`);
				return;
			case 'down':
				if (!this.buttonHeld) {
					this.write(`down ${position}`);
					this.buttonHeld = true;
				}
				return;
			case 'up':
				if (this.buttonHeld) {
					this.write(`up ${position}`);
					this.buttonHeld = false;
				}
				return;
			case 'drag':
				if (this.buttonHeld) this.write(`drag ${position}`);
				return;
			case 'scroll': {
				const deltaX = Math.round((input.deltaX ?? 0) * this.bounds.width);
				const deltaY = Math.round((input.deltaY ?? 0) * this.bounds.height);
				if (deltaX || deltaY)
					this.write(`scroll ${position} ${deltaX} ${deltaY}`);
			}
		}
	}

	private position(x: number, y: number): string {
		const globalX = this.bounds.x + x * (this.bounds.width - 1);
		const globalY = this.bounds.y + y * (this.bounds.height - 1);
		return `${globalX.toFixed(3)} ${globalY.toFixed(3)}`;
	}

	private write(command: string): void {
		this.child?.stdin.write(`${command}\n`);
	}
}
