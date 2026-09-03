import { existsSync } from 'fs';
import { join, resolve } from 'path';
import { app } from 'electron';

const hasBundle = (directory: string, indexFile: string = 'index.html'): boolean => {
	if (!directory) {
		return false;
	}

	const indexPath = join(directory, indexFile);
	return existsSync(indexPath);
};

const normalizeCandidates = (candidates: string[]): string[] => {
	const normalized = new Set<string>();

	candidates.forEach((candidate) => {
		if (!candidate) {
			return;
		}

		const resolvedCandidate = resolve(candidate);
		normalized.add(resolvedCandidate);
	});

	return [...normalized];
};

export const getClientViewerDistPath = (): string => {
	const resourcesPath = process.resourcesPath ?? '';
	const appPath = app.getAppPath();

	const candidates = normalizeCandidates([
		join(__dirname, '../client-viewer'),
		join(appPath, 'client-viewer'),
		join(appPath, 'out/client-viewer'),
		join(resourcesPath, 'client-viewer'),
		join(resourcesPath, 'app.asar.unpacked/client-viewer'),
		join(process.cwd(), 'out/client-viewer'),
		join(process.cwd(), 'src/client-viewer/dist'),
	]);

	for (const candidate of candidates) {
		if (hasBundle(candidate)) {
			return candidate;
		}
	}

	return '';
};

export const getIpadViewerDistPath = (): string => {
	const resourcesPath = process.resourcesPath ?? '';
	const appPath = app.getAppPath();
	const cwd = process.cwd();

	// Get the parent directory (out/) from the main/index.js location
	const mainIndexDir = join(__dirname, '..');

	const candidates = normalizeCandidates([
		// From main chunk directory
		join(mainIndexDir, 'ipad-viewer'),
		// From root of out/ directory (where chunks/, index.js are)
		join(__dirname, '../../ipad-viewer'),
		// From app path
		join(appPath, 'ipad-viewer'),
		join(appPath, 'out/ipad-viewer'),
		// From resources
		join(resourcesPath, 'ipad-viewer'),
		join(resourcesPath, 'app.asar.unpacked/ipad-viewer'),
		// From working directory
		join(cwd, 'out/ipad-viewer'),
	]);

	for (const candidate of candidates) {
		if (hasBundle(candidate)) {
			console.log('[iPad Viewer] Found at:', candidate);
			return candidate;
		}
	}

	console.log('[iPad Viewer] WARNING: iPad viewer not found in any location');
	return '';
};
