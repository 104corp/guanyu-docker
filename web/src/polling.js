const { cache, prepareLogger } = require('guanyu-core');
const httperror = require('./httperror');
const extend = require('extend');
const logFn = "web:src/polling";

function polling(payload) {
  const logger = prepareLogger({ loc: `${logFn}:polling` });
  let time = [0, 1];
  let pullID;
  let timerID;
  let options = payload.options;
  let noncached = payload.noncached;

  if (payload.result) {
    return Promise.resolve(payload);
  }

  function bypass_cache(payload) {
    if (payload.options) {
      if (payload.options.bypass_cache || payload.options.bypass_read_cache) {
        logger.debug(`Skip cache lookup as requested "${payload.hash}"`)
        delete payload.result;
        cache.update_result_ddb(payload);
        return Promise.resolve(payload)
      }
    }
    return Promise.resolve(payload)
  }
  

  function end() {
    pullID = pullID && clearInterval(pullID);
    timerID = timerID && clearTimeout(timerID);
  };

  function checkResult() {
    return (payload) => {
      if (payload.status || payload.result) {
        end();
        logger.debug("Polling stop");
        cache.update_result_naive(payload).then(() => {
          if (noncached) {
            delete payload.cached;
            extend(payload, { options: options });
          }
          if (payload.status) {
            return this.reject(payload);
          }
          return this.resolve(payload);
        });
      }
      if (timerID) {
        clearInterval(pullID);
        startInterval();
      }
    }
  };

  function setEndMethod(resolve, reject) {
    this.resolve = resolve;
    this.reject = reject;
  }

  function startInterval() {
    pullID = setInterval(() => {
      cache.get_result_ddb(payload).then(checkResult());
    }, getIntervalTime() * 1000);
  }

  function getIntervalTime() {
    let intervalTime = time[0] + time[1];

    if (intervalTime < 5) {
      time[0] = time[1];
      time[1] = intervalTime;
    }

    return intervalTime;
  }

  logger.debug("Polling start...");
  return new Promise((resolve, reject) => {
    setEndMethod(resolve, reject);
    timerID = setTimeout(() => {
      end();
      logger.debug("Polling timeout");
      reject(httperror.GATEWAY_TIMEOUT);
    }, (payload.responseTime || 60) * 1000);
    bypass_cache(payload).then(startInterval)
  });
}

module.exports = {
  polling: polling
}
