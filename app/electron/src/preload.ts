require('./rt/electron-rt');
//////////////////////////////
// User Defined Preload scripts below

// Tell the page it runs in the desktop shell (and on which OS), so the header can act as the title bar and
// leave room for the window controls.
window.addEventListener('DOMContentLoaded', () => {
  document.documentElement.dataset.shell = 'electron';
  document.documentElement.dataset.platform = process.platform;
});
