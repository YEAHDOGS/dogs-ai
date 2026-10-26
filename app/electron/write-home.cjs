// Records where the dogs-ai project lives, so the packaged app can start `dogs serve` from it.
// Override at runtime with the DOGS_HOME environment variable.
const fs = require('fs')
const path = require('path')

const target = path.join(__dirname, 'build', 'dogs-home.json')
// A CI runner's checkout means nothing on the machine that installs the app.
if (process.env.CI && !process.env.DOGS_HOME) {
  fs.rmSync(target, { force: true })
  console.log('dogs home: not recorded (CI build)')
  process.exit(0)
}

const HOME = process.env.DOGS_HOME || path.resolve(__dirname, '..', '..')
fs.writeFileSync(target, JSON.stringify({ home: HOME }, null, 1))
console.log(`dogs home: ${HOME}`)
