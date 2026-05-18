const { app } = require('electron');
app.whenReady().then(() => {
  try {
    const raop = require('@lox-audioserver/node-libraop');
    console.log('electron load ok');
    const handle = raop.startReceiver({ name: 'ECHO Smoke', model: 'ECHO-Smoke', host: '192.168.31.214', mac: '60:CF:84:CB:1E:D1', metadata: true, portBase: 6000, portRange: 100 }, (event) => console.log('event', event));
    console.log('start ok', handle);
    setTimeout(() => { try { raop.stopReceiver(handle); console.log('stop ok'); } finally { app.quit(); } }, 2000);
  } catch (error) {
    console.error('failed', error && error.stack ? error.stack : String(error));
    process.exitCode = 1;
    app.quit();
  }
});
