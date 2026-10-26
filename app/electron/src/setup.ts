import type { CapacitorElectronConfig } from '@capacitor-community/electron';
import {
  CapElectronEventEmitter,
  CapacitorSplashScreen,
  setupCapacitorElectronPlugins,
} from '@capacitor-community/electron';
import chokidar from 'chokidar';
import type { MenuItemConstructorOptions } from 'electron';
import { app, BrowserWindow, Menu, MenuItem, nativeImage, shell, Tray, session } from 'electron';
import electronIsDev from 'electron-is-dev';
import electronServe from 'electron-serve';
import windowStateKeeper from 'electron-window-state';
import { join } from 'path';

// Height of the app header, which doubles as the window's title bar (keep in step with .titlebar in app.css).
const TITLEBAR_HEIGHT = 56;
// Same as appId in electron-builder.config.json, which the installer's shortcuts carry.
export const APP_USER_MODEL_ID = 'net.wearedogs.ai';
// Set by live-runner.js (npm run desktop:dev): load the Vite dev server so edits hot-reload.
const DEV_URL = electronIsDev ? process.env.DOGS_DEV_URL : undefined;

// Define components for a watcher to detect when the webapp is changed so we can reload in Dev mode.
const reloadWatcher = {
  debouncer: null,
  ready: false,
  watcher: null,
};
export function setupReloadWatcher(electronCapacitorApp: ElectronCapacitorApp): void {
  reloadWatcher.watcher = chokidar
    .watch(join(app.getAppPath(), 'app'), {
      ignored: /[/\\]\./,
      persistent: true,
    })
    .on('ready', () => {
      reloadWatcher.ready = true;
    })
    .on('all', (_event, _path) => {
      if (reloadWatcher.ready) {
        clearTimeout(reloadWatcher.debouncer);
        reloadWatcher.debouncer = setTimeout(async () => {
          electronCapacitorApp.getMainWindow().webContents.reload();
          reloadWatcher.ready = false;
          clearTimeout(reloadWatcher.debouncer);
          reloadWatcher.debouncer = null;
          reloadWatcher.watcher = null;
          setupReloadWatcher(electronCapacitorApp);
        }, 1500);
      }
    });
}

// Define our class to manage our app.
export class ElectronCapacitorApp {
  private MainWindow: BrowserWindow | null = null;
  private SplashScreen: CapacitorSplashScreen | null = null;
  private TrayIcon: Tray | null = null;
  private CapacitorFileConfig: CapacitorElectronConfig;
  private TrayMenuTemplate: (MenuItem | MenuItemConstructorOptions)[] = [
    new MenuItem({ label: 'Quit App', role: 'quit' }),
  ];
  private AppMenuBarMenuTemplate: (MenuItem | MenuItemConstructorOptions)[] = [
    { role: process.platform === 'darwin' ? 'appMenu' : 'fileMenu' },
    { role: 'viewMenu' },
  ];
  private mainWindowState;
  private loadWebApp;
  private customScheme: string;

  constructor(
    capacitorFileConfig: CapacitorElectronConfig,
    trayMenuTemplate?: (MenuItemConstructorOptions | MenuItem)[],
    appMenuBarMenuTemplate?: (MenuItemConstructorOptions | MenuItem)[]
  ) {
    this.CapacitorFileConfig = capacitorFileConfig;

    this.customScheme = this.CapacitorFileConfig.electron?.customUrlScheme ?? 'capacitor-electron';

    if (trayMenuTemplate) {
      this.TrayMenuTemplate = trayMenuTemplate;
    }

    if (appMenuBarMenuTemplate) {
      this.AppMenuBarMenuTemplate = appMenuBarMenuTemplate;
    }

    // Setup our web app loader, this lets us load apps like react, vue, and angular without changing their build chains.
    this.loadWebApp = electronServe({
      directory: join(app.getAppPath(), 'app'),
      scheme: this.customScheme,
    });
  }

  // Helper function to load in the app.
  private async loadMainWindow(thisRef: any) {
    if (DEV_URL) await thisRef.MainWindow.loadURL(DEV_URL);
    else await thisRef.loadWebApp(thisRef.MainWindow);
  }

  // Expose the mainWindow ref for use outside of the class.
  getMainWindow(): BrowserWindow {
    return this.MainWindow;
  }

  getCustomURLScheme(): string {
    return this.customScheme;
  }

  async init(): Promise<void> {
    const icon = nativeImage.createFromPath(
      join(app.getAppPath(), 'assets', process.platform === 'win32' ? 'appIcon.ico' : 'appIcon.png')
    );
    this.mainWindowState = windowStateKeeper({
      defaultWidth: 1000,
      defaultHeight: 800,
    });
    // Setup preload script path and construct our main window.
    const preloadPath = join(app.getAppPath(), 'build', 'src', 'preload.js');
    this.MainWindow = new BrowserWindow({
      icon,
      show: false,
      x: this.mainWindowState.x,
      y: this.mainWindowState.y,
      width: this.mainWindowState.width,
      height: this.mainWindowState.height,
      minWidth: 360,
      minHeight: 520,
      backgroundColor: '#020203',
      // No system title bar: the app's header is the title bar. Windows/Linux keep native min/max/close drawn
      // over it (so Snap Layouts still work); macOS keeps its traffic lights, inset into the header.
      titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'hidden',
      ...(process.platform === 'darwin'
        ? { trafficLightPosition: { x: 18, y: 20 } }
        : { titleBarOverlay: { color: '#00000000', symbolColor: '#e5e5e5', height: TITLEBAR_HEIGHT } }),
      webPreferences: {
        // The page never needs Node; only the preload does (it keeps it because sandbox stays off).
        nodeIntegration: false,
        // Electron sandboxes preloads by default, and a sandboxed preload cannot require the Capacitor runtime.
        sandbox: false,
        contextIsolation: true,
        webSecurity: true,
        // Use preload to inject the electron varriant overrides for capacitor plugins.
        // preload: join(app.getAppPath(), "node_modules", "@capacitor-community", "electron", "dist", "runtime", "electron-rt.js"),
        preload: preloadPath,
      },
    });
    this.mainWindowState.manage(this.MainWindow);

    // The taskbar and its jump list name the app after the running exe, which is "Electron" in dev.
    if (process.platform === 'win32') {
      this.MainWindow.setAppDetails({
        appId: APP_USER_MODEL_ID,
        appIconPath: join(app.getAppPath(), 'assets', 'appIcon.ico'),
        relaunchDisplayName: 'DOGS AI',
        relaunchCommand: app.isPackaged ? `"${process.execPath}"` : `"${process.execPath}" "${app.getAppPath()}"`,
      });
    }

    if (this.CapacitorFileConfig.backgroundColor) {
      this.MainWindow.setBackgroundColor(this.CapacitorFileConfig.electron.backgroundColor);
    }

    // If we close the main window with the splashscreen enabled we need to destory the ref.
    this.MainWindow.on('closed', () => {
      if (this.SplashScreen?.getSplashWindow() && !this.SplashScreen.getSplashWindow().isDestroyed()) {
        this.SplashScreen.getSplashWindow().close();
      }
    });

    // When the tray icon is enabled, setup the options.
    if (this.CapacitorFileConfig.electron?.trayIconAndMenuEnabled) {
      this.TrayIcon = new Tray(icon);
      this.TrayIcon.on('double-click', () => {
        if (this.MainWindow) {
          if (this.MainWindow.isVisible()) {
            this.MainWindow.hide();
          } else {
            this.MainWindow.show();
            this.MainWindow.focus();
          }
        }
      });
      this.TrayIcon.on('click', () => {
        if (this.MainWindow) {
          if (this.MainWindow.isVisible()) {
            this.MainWindow.hide();
          } else {
            this.MainWindow.show();
            this.MainWindow.focus();
          }
        }
      });
      this.TrayIcon.setToolTip(app.getName());
      this.TrayIcon.setContextMenu(Menu.buildFromTemplate(this.TrayMenuTemplate));
    }

    // macOS keeps its menu in the system menu bar (copy/paste, quit shortcuts); elsewhere there is no menu bar.
    Menu.setApplicationMenu(process.platform === 'darwin' ? Menu.buildFromTemplate(this.AppMenuBarMenuTemplate) : null);

    // If the splashscreen is enabled, show it first while the main window loads then switch it out for the main window, or just load the main window from the start.
    if (this.CapacitorFileConfig.electron?.splashScreenEnabled) {
      this.SplashScreen = new CapacitorSplashScreen({
        imageFilePath: join(
          app.getAppPath(),
          'assets',
          this.CapacitorFileConfig.electron?.splashScreenImageName ?? 'splash.png'
        ),
        windowWidth: 400,
        windowHeight: 400,
      });
      this.SplashScreen.init(this.loadMainWindow, this);
    } else {
      this.loadMainWindow(this);
    }

    // Security: the window only ever shows the app itself. New windows are never opened in-app; web links
    // (e.g. Hugging Face) go to the system browser. Navigation away from the app's own scheme is blocked.
    const isAppUrl = (u: string) => {
      try {
        return new URL(u).protocol === `${this.customScheme}:`;
      } catch {
        return false;
      }
    };
    this.MainWindow.webContents.setWindowOpenHandler((details) => {
      if (/^https?:/.test(details.url)) shell.openExternal(details.url);
      return { action: 'deny' };
    });
    this.MainWindow.webContents.on('will-navigate', (event, newURL) => {
      if (!isAppUrl(newURL)) event.preventDefault();
    });

    // Link electron plugins into the system.
    setupCapacitorElectronPlugins();

    // When the web app is loaded we hide the splashscreen if needed and show the mainwindow.
    this.MainWindow.webContents.on('dom-ready', () => {
      if (this.CapacitorFileConfig.electron?.splashScreenEnabled) {
        this.SplashScreen.getSplashWindow().hide();
      }
      if (!this.CapacitorFileConfig.electron?.hideMainWindowOnLaunch) {
        this.MainWindow.show();
      }
      setTimeout(() => {
        if (electronIsDev && process.env.DOGS_DEVTOOLS === '1') {
          this.MainWindow.webContents.openDevTools();
        }
        CapElectronEventEmitter.emit('CAPELECTRON_DeeplinkListenerInitialized', '');
      }, 400);
    });
  }
}

// Set a CSP up for our application based on the custom scheme
export function setupContentSecurityPolicy(customScheme: string): void {
  // Where the page may fetch API data and media from: the local engine, plus (for the Settings "server URL",
  // e.g. a GPU box on the LAN) any http(s) host. Set DOGS_CSP_SOURCES="" to allow the local engine only.
  const API_SOURCES = `http://127.0.0.1:* http://localhost:* ${process.env.DOGS_CSP_SOURCES ?? 'http: https:'}`.trim();
  // img-src replaces default-src for images, so the app's own bundled images need its scheme listed again.
  const IMG_SOURCES = `${customScheme}://* ${API_SOURCES} data: blob:`;
  // The Vite dev server serves the page and pushes hot updates over a websocket.
  const DEV_SOURCES = DEV_URL ? 'http://127.0.0.1:* http://localhost:*' : '';
  const DEV_SOCKETS = DEV_URL ? 'ws://127.0.0.1:* ws://localhost:*' : '';
  session.defaultSession.webRequest.onHeadersReceived((details, callback) => {
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          electronIsDev
            ? `default-src ${customScheme}://* ${DEV_SOURCES} 'unsafe-inline' devtools://* 'unsafe-eval' data:; connect-src ${API_SOURCES} ${DEV_SOCKETS}; img-src ${IMG_SOURCES}; media-src ${API_SOURCES} blob:; worker-src blob:`
            : `default-src ${customScheme}://* 'unsafe-inline' data:; connect-src ${API_SOURCES}; img-src ${IMG_SOURCES}; media-src ${API_SOURCES} blob:; worker-src blob:`,
        ],
      },
    });
  });
}
