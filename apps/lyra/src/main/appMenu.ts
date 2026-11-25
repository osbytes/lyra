import { Menu, type MenuItemConstructorOptions } from 'electron'

/**
 * The application menu. Without one Electron installs its default, whose View menu has Reload,
 * Force Reload and Toggle Developer Tools: a reload throws away the renderer, and with it a
 * recording in progress. Those stay for development only.
 */
export function installAppMenu(options: { developer: boolean }): void {
  const developer: MenuItemConstructorOptions[] = options.developer
    ? [{ role: 'reload' }, { role: 'forceReload' }, { role: 'toggleDevTools' }, { type: 'separator' }]
    : []
  const template: MenuItemConstructorOptions[] = [
    ...(process.platform === 'darwin' ? [{ role: 'appMenu' } satisfies MenuItemConstructorOptions] : []),
    { role: 'fileMenu' },
    { role: 'editMenu' },
    {
      label: 'View',
      submenu: [
        ...developer,
        { role: 'resetZoom' },
        { role: 'zoomIn' },
        { role: 'zoomOut' },
        { type: 'separator' },
        { role: 'togglefullscreen' }
      ]
    },
    { role: 'windowMenu' }
  ]
  Menu.setApplicationMenu(Menu.buildFromTemplate(template))
}
