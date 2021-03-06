/* eslint no-process-exit:off */
'use strict';
/* eslint no-process-exit:off */
/**
 * Created by krasilneg on 19.07.17.
 */
const config = require('../config');
const di = require('core/di');

const IonLogger = require('core/impl/log/IonLogger');
const sysLog = new IonLogger(config.log || {});
const errorSetup = require('core/error-setup');
const alias = require('core/scope-alias');
const extend = require('extend');
errorSetup(config.lang || 'ru');

let jobName = false;

if (process.argv.length > 2) {
  jobName = process.argv[2];
} else {
  console.error('Job name not passed');
  process.exit(130);
}

let job = false;
let notifier = null;

di('boot', config.bootstrap,
  {
    sysLog: sysLog
  }, null, ['rtEvents'])
  .then(scope =>
    di(
      'app',
      extend(true, config.di, scope.settings.get('plugins') || {}),
      {},
      'boot',
      ['auth', 'sessionHandler', 'background', 'scheduler', 'application']
    )
  )
  .then(scope => alias(scope, scope.settings.get('di-alias')))
  .then(
    /**
     * @param {{}} scope
     * @param {SettingsRepository} [scope.settings]
     * @returns {Promise}
     */
    (scope) => {
      let jobs = scope.settings.get('jobs') || {};
      if (
        jobs.hasOwnProperty(jobName) &&
        jobs[jobName] &&
        typeof jobs[jobName] === 'object'
      ) {
        job = jobs[jobName];
        notifier = scope.notifier;
        if (!job.worker) {
          throw new Error('Job component not specified ' + jobName);
        }
        return di('job', jobs[jobName].di || {}, {}, 'app');
      } else {
        throw new Error('Job ' + jobName + ' not found');
      }
    }
  )
  .then((scope) => {
    let worker = scope[job.worker];
    if (!worker) {
      throw new Error('Working component of the job was not found ' + jobName);
    }
    if (typeof worker !== 'function' && typeof worker.run !== 'function') {
      throw new Error('Working component of the job '  + jobName + ' has no start method');
    }
    let msg = 'Start the job ' + jobName;
    sysLog.info(msg);
    let promise = Promise.resolve();
    if (notifier && job.notify) {
      promise = promise.then(() => notifier.notify({
        subject: jobName,
        message: msg,
        sender: job.sender,
        recievers: job.notify
      }));
    }
    return promise.then(() => (typeof worker === 'function') ? worker() : worker.run());
  })
  .then(() => {
    let msg = 'Job ' + jobName + ' done';
    sysLog.info(msg);
    let p = Promise.resolve();
    if (notifier && job.notify) {
      p = p.then(() => notifier.notify({
        subject: jobName,
        message: msg,
        sender: job.sender,
        recievers: job.notify
      }));
    }
    return p.then(() => {
      process.exit(0);
    });
  })
  .catch((err) => {
    sysLog.error(err);
    let p = Promise.resolve();
    if (notifier && job.notify) {
      p = p.then(() => notifier.notify({
        subject: jobName,
        message: err,
        sender: job.sender,
        recievers: job.notify
      }));
    }
    p
      .catch(() => {
        sysLog.error(err);
      })
      .then(() => {
        process.exit(130);
      });
  });