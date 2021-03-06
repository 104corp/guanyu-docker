'use strict';

const CONTENT_MISSING = new Error('Content Missing');
CONTENT_MISSING.status = 400;

const FORBIDDEN = new Error('Forbidden');
FORBIDDEN.status = 403;

const NOT_FOUND = new Error('Not Found');
NOT_FOUND.status = 404;

const TOO_MANY_REQUESTS = new Error('Too Many Requests');
TOO_MANY_REQUESTS.status = 509;

module.exports = {
  CONTENT_MISSING: CONTENT_MISSING,
  FORBIDDEN: FORBIDDEN,
  NOT_FOUND: NOT_FOUND,
  TOO_MANY_REQUESTS: TOO_MANY_REQUESTS,
};
