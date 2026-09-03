import { resolve } from 'path';
import {
	defineConfig,
	externalizeDepsPlugin,
} from 'electron-vite';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore
import react from '@vitejs/plugin-react';
import fs from 'fs-extra';

// Custom Vite plugin to copy the 'client-viewer/dist' directory
const copyClientViewerStaticFiles = () => {
	return {
		name: 'copy-client-viewer-static-files',
		async writeBundle() {
			const sourceDir = resolve(__dirname, 'src/client-viewer/dist');
			const destDir = resolve(__dirname, 'out/client-viewer');

			console.log(`Attempting to copy static files from: ${sourceDir}`);
			console.log(`To destination: ${destDir}`);

			try {
				await fs.emptyDir(destDir);
				await fs.copy(sourceDir, destDir);
				console.log(
					'Successfully copied client-viewer/dist to out/client-viewer',
				);
			} catch (err) {
				console.error(`Error copying static files: ${err}`);
			}
		},
	};
};

const copySimplePeerMinJsStaticFiles = () => {
	return {
		name: 'copy-simple-peer-min-js-static-files',
		async writeBundle() {
			const sourceFile = resolve(
				__dirname,
				'node_modules/simple-peer/simplepeer.min.js',
			);
			const destDir = resolve(__dirname, 'out/renderer/assets');

			console.log(`Attempting to copy simple-peer.min.js from: ${sourceFile}`);
			console.log(`To destination: ${destDir}`);

			try {
				await fs.ensureDir(destDir);
				await fs.copyFile(sourceFile, resolve(destDir, 'simplepeer.min.js'));
				console.log(
					'Successfully copied simple-peer.min.js to out/client-viewer/static/js',
				);
			} catch (err) {
				console.error(`Error copying simple-peer.min.js: ${err}`);
			}
		},
	};
};

// Custom Vite plugin to copy the 'ipad-viewer' directory
const copyIpadViewerStaticFiles = () => {
	return {
		name: 'copy-ipad-viewer-static-files',
		async writeBundle() {
			const sourceDir = resolve(__dirname, 'src/ipad-viewer');
			const destDir = resolve(__dirname, 'out/ipad-viewer');
			const vendorDir = resolve(destDir, 'vendor');

			console.log(`Copying iPad viewer from: ${sourceDir}`);

			try {
				await fs.emptyDir(destDir);
				await fs.copy(sourceDir, destDir);
				await fs.ensureDir(vendorDir);
				await Promise.all([
					fs.copyFile(
						resolve(__dirname, 'node_modules/simple-peer/simplepeer.min.js'),
						resolve(vendorDir, 'simplepeer.min.js'),
					),
					fs.copyFile(
						resolve(__dirname, 'node_modules/socket.io-client/dist/socket.io.min.js'),
						resolve(vendorDir, 'socket.io.min.js'),
					),
					fs.copyFile(
						resolve(__dirname, 'src/renderer/src/assets/logo192.png'),
						resolve(destDir, 'apple-touch-icon.png'),
					),
				]);
				console.log('Successfully copied iPad viewer to out/ipad-viewer');
			} catch (err) {
				console.error(`Error copying iPad viewer: ${err}`);
			}
		},
	};
};

export default defineConfig({
	main: {
		plugins: [externalizeDepsPlugin()],
		build: {
			rollupOptions: {
				input: {
					index: resolve(__dirname, 'src/main/index.ts'),
					'ipad-host': resolve(__dirname, 'src/ipad-host/index.ts'),
				},
			},
		},
	},
	preload: {
		build: {
			rollupOptions: {
				input: {
					index: resolve(__dirname, 'src/preload/index.ts'),
					helperRenderer: resolve(__dirname, 'src/preload/index.ts'),
				},
			},
		},
		plugins: [externalizeDepsPlugin()],
	},
	renderer: {
		build: {
			rollupOptions: {
				input: {
					index: resolve(__dirname, 'src/renderer/index.html'),
					helperRenderer: resolve(
						__dirname,
						'src/renderer/peerConnectionHelperRendererWindowIndex.html',
					),
				},
			},
		},
		resolve: {
			alias: {
				'@renderer': resolve('src/renderer/src'),
				'@common': resolve('src/common'),
			},
		},
		plugins: [
			react(),
			copyClientViewerStaticFiles(),
			copySimplePeerMinJsStaticFiles(),
			copyIpadViewerStaticFiles(),
		],
	},
});
