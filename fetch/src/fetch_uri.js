const extend = require('extend');
const { aws, config, cache, prepareLogger } = require('guanyu-core');
const crypto = require('crypto');
const request = require('request');
const tmp = require('tmp');
const logFn = 'fetch:src/fetch_uri'
const plogger = prepareLogger;
const s3 = new aws.S3();
const sqs = new aws.SQS();

const file_max_size = config.get('MAX_SIZE');
const bucketName = config.get('STACK:SAMPLE_BUCKET');


const s3Stream = require('s3-upload-stream')(s3);

/**
 * Wraps _fetch_uri and handle fall_with_upstream
 *
 * @param payload
 * @returns {Promise}
 */
function fetch_uri(payload) {
	let fall_with_upstream = payload.options && payload.options.fall_with_upstream;

	if (fall_with_upstream)
		return _fetch_uri(payload).catch(function (payload) {
			return Promise.resolve(payload);
		});

	return _fetch_uri(payload).catch(function (payload) {
		extend(payload, {
			malicious: false,
			result: `#${payload.message}`,
		});

		delete payload.error;
		delete payload.status;
		delete payload.message;

		return Promise.resolve(payload);
	});
}


/**
 *
 * @param payload
 * @returns {Promise}
 * @private
 */
function _fetch_uri(payload) {
	const logger = plogger({ loc: `${logFn}:_fetch_uri` })

	if (!/^https?:\/\/.+/.test(payload.resource)) {
		logger.warn(`Unsupported uri: ${payload.resource}`);
		return Promise.reject(extend({}, payload, {
			status: 400,
			message: `Unsupported uri: ${payload.resource}`
		}));
	}

	return new Promise((fulfill, reject) => {
		let name = tmp.tmpNameSync({ template: 'guanyu-XXXXXXXX' });
	
		logger.debug(`Fetching "${payload.resource}" to "${name}"`);

		request({ method: "HEAD", url: payload.resource }, (err, headRes) => {
			if (err)
				return reject(extend(payload, {
					status: 500,
					error: err,
				}));

			// Catches upstream 4XX
			if (Math.floor(headRes.statusCode / 100) == 4) {
				return reject(extend(payload, {
					status: 400,
					message: "Upstream failed: " + headRes.statusMessage,
				}))
			}

			let size = headRes.headers['content-length'];
			if (size > file_max_size) {
				return reject(extend(payload, {
					status: 413,
					message: "Resource too large",
					result: new Error(`Resource size "${size}" exceeds limit "${file_max_size}"`)
				}));
			}


			let fetched_size = 0;
			let res = request({ url: payload.resource });


  			let shasum = crypto.createHash('sha256');

			res
				.on('data', (data) => {
					shasum.update(data)
					fetched_size += data.length;
					if (fetched_size > file_max_size) {
						res.abort();
						payload = extend(payload, {
							status: 413,
							message: "Resource too large",
							error: new Error(`Fetched size "${fetched_size}" exceeds limit "${file_max_size}"`)
						});

						payload.deletefile = true;
						payload.filename = name;

						return reject(payload)
					}
				})
				.pipe(
					s3Stream.upload({
						Bucket: bucketName,
						Key: name,
						ACL: "public-read"
					  })
				)
				.on('uploaded', () => {
					payload.filename = name;
					logger.debug(`Saved to S3 ${payload.filename}`);
					payload.filehash = shasum.digest('base64');
					fulfill(payload);
				})
				.on('error', (err) => {
					logger.error(`fectch ${name} failed`);
					// Fetch failed
					reject(extend(payload, {
						status: "400",
						message: "fetch failed",
						error: err,
					}));
				});
		});
	});
}


/**
 *
 * @param payload
 * @returns {Promise}
 */
function file_cache(payload) {
	const logger = plogger({ loc: `${logFn}:file_cache` })
	if (!payload.filehash) {
		logger.info(`Skip get DDB cache for !filehash`);
		return Promise.resolve(payload);
	}

	let file_payload = {};
	file_payload.hash = payload.filehash;
	file_payload.options = payload.options;
	
	return cache.get_result(file_payload).then((cache_data) => {
		if (cache_data.result !== undefined && cache_data.malicious !== undefined) {
			logger.info(`Find cache from file hash: ${payload.filehash}`);
			payload.malicious = cache_data.malicious;
			payload.result = cache_data.result;
			payload.deletefile = true; 
			delete payload.filehash;
		}

		return Promise.resolve(payload);
	})
}

/**
 *
 * @param payload
 * @returns {Promise}
 * @private
 */
function sendScanQueue(payload) {
	const logger = plogger({ loc: `${logFn}:sendScanQueue` })

	if (payload.result || !payload.filename) {
		logger.info(`Skip sav scan for result or !filename, don't send scan queue`);
		return Promise.resolve(payload);
	}

	logger.info(`Send message to scan queue`);

	let sqsParams = {
		MessageBody: JSON.stringify(payload),
		QueueUrl: config.get('PLUGIN:SOPHOSAV:QUEUE')
	};

	return new Promise((resolve, reject) => {
		sqs.sendMessage(sqsParams, (err, data) => {
			if (err)
				return reject(extend(payload, {
					error: err
				}));

			return resolve(payload);
		})
	})
}


/**
 *
 * @param payload
 * @returns {Promise}
 */
function delete_file(payload) {
	const logger = plogger({ loc: `${logFn}:delete_file` })
	
	if(!payload.deletefile){
		logger.debug(`Skip delete file in S3 for !deletefile`);
		return Promise.resolve(payload); 
	}

	let params = {
		Bucket: bucketName,
		Key: payload.filename
	};

	return new Promise((resolve, reject) => {
		s3.deleteObject(params, (err, data) => {
			if (err) {
				logger.error(`Failed to delete ${payload.filename} in S3`);
				return resolve(payload);
			}
				
			logger.info(`Success delete ${payload.filename} in S3`);
			delete payload.deletefile;

			return resolve(payload);
		})
	})
}



/**
 *
 * @param payload
 * @returns {Promise}
 */
function update_result(payload) {
	const logger = plogger({ loc: `${logFn}:update_result` })

	if (payload.result || !payload.filename) {
		logger.info(`Update result to DB`);
		delete payload.cache;
		delete payload.filename;
		delete payload.options;
		return cache.update_result(payload);
	}

	return Promise.resolve(payload);
}


/**
 *
 * @param payload
 * @returns {*}
 */
function fetch_uri_and_upload(payload) {
	return fetch_uri(payload)
		.then(file_cache)
		.then(delete_file)
		.then(update_result)
		.then(sendScanQueue)
}

module.exports = {
	fetch_uri_and_upload: fetch_uri_and_upload,
};