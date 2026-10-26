// Records where the dogs-ai project lives, so the packaged app can start `dogs serve` from it.
// Override at runtime with the DOGS_HOME environment variable.
const fs = require('fs')
const path = require('path')

const HOME = process.env.DOGS_HOME || path.resolve(__dirname, '..', '..')
fs.writeFileSync(path.join(__dirname, 'build', 'dogs-home.json'), JSON.stringify({ home: HOME }, null, 1))
console.log(`dogs home: ${HOME}`)
