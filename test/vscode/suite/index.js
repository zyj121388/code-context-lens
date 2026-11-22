'use strict';

const path = require('node:path');
const Mocha = require('mocha');

exports.run = async function run() {
  const mocha = new Mocha({
    ui: 'tdd',
    color: true,
    timeout: 60000,
  });
  mocha.addFile(path.resolve(__dirname, 'extension.test.js'));

  await new Promise((resolve, reject) => {
    mocha.run((failures) => {
      if (failures > 0) {
        reject(new Error(`${failures} integration tests failed.`));
      } else {
        resolve();
      }
    });
  });
};
