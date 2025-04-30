/* eslint-disable camelcase */
'use strict';

const requestUtils = require('./request-utils');
const log     = require('cf-nodejs-logging-support');
const { v4: uuid } = require('uuid');
const fs      = require('fs');
const FormData = require('form-data');
const xsenv = require('@sap/xsenv');

class GACDHandler {

  constructor(service, token, contentZipPath) {
    this.service  = service;
    this.token    = token;
    this.contentZipPath = contentZipPath;
    this.deployStatus = null;
    this.uploadResponse = null;
    this.deployResponse = null;
    this.intervalId = null;
  }

  upload(){
    log.logMessage('info','Starting upload');
    return new Promise((resolve,reject) => {
      let errMessage = null;
      log.logMessage('info','Sending rquest to upload');
      const formData = new FormData();
      formData.append('file', fs.createReadStream(this.contentZipPath), {'content-type': 'application/zip'});
      requestUtils.post(this._getRequestOptions('/v2/files/upload',formData), (err, res, body) => {
        if (res && res.statusCode === 201) {
          log.logMessage('info','Upload completed');
          this.uploadResponse = JSON.parse(body);
          resolve();
        }
        else {
          if (err) {
            errMessage = new Error('Error in upload request: ' + err.message);
          } else {
            errMessage = new Error('Error while uploading resources to server; Status: ' + (res && res.statusCode) +
                ' Response: ' + body);
          }
          log.logMessage('error',errMessage);
          reject(errMessage);
        }
      });
    });
  }

  deploy(){
    return new Promise((resolve) => {
      const configuration = this._getConfiguration();
      console.info('configuration for deploy: ' + JSON.stringify(configuration));
      console.info(configuration);
      const body = {contents: [{storageType: 'FILE', uri: this.uploadResponse.fileId}]};
      configuration && (body.configuration = configuration);
      this._sendGACDRequest(this._getRequestOptions('/v2/deploys', body),'post', 201, 'deploy')
        .then ((deployResponse) => {
          log.logMessage('info','deployResponse from deploy request: ' + JSON.stringify(this.deployResponse));
          this.deployResponse = deployResponse;
          resolve();
        });
    });
  }

  pollDeployStatus(){
    return new Promise((resolve, reject) => {
      let message = null;
      if (!this.deployResponse){
        return reject('Failed to get deploy response');
      }
      this.intervalId = setInterval(() => {
        log.logMessage('info','deployResponse before get deploy status: ' + JSON.stringify(this.deployResponse));
        let deployResourceId = this.deployResponse.contents[0].uri;
        this.getDeployStatus(deployResourceId)
          .then((result) => {
            log.logMessage('info','deployStatus response' + result);
            let deployStatus = result.contents[0].deployStatus;
            log.logMessage('info', 'Deploy status: ' + deployStatus);
            if (deployStatus === 'SUCCESS' || deployStatus === 'WARNING'){
              log.logMessage('info', 'HTML5 Applications succesfully deployed');
              clearInterval(this.intervalId);
              return resolve();
            } else if (deployStatus === 'CONTENT_ERROR' || deployStatus === 'SEVERE_ERROR'){
              log.logMessage('error', 'Failed to deploy HTML5 Applications');
              this.getDeployLogs(this.deployResponse.contents[0].uri)
                .then((logs) => {
                  let message = JSON.stringify(logs, null, 4);
                  log.logMessage('error', 'Deploy logs ' + message);
                  clearInterval(this.intervalId);
                  if (process.env.ASYNC_UPLOAD){
                    return resolve();
                  } else {
                    return reject(new Error(message));
                  }
                })
                .catch((err) => {
                  message = 'Failed to get deploy logs for resource ' + this.deployResponse.contents[0].uri + ' ' + err;
                  log.logMessage(message);
                  clearInterval(this.intervalId);
                  return reject(message);
                });
              clearInterval(this.intervalId);
            }
          })
          .catch((err) => {
            message = 'Failed to get deploy status for resource ' + this.deployResponse.contents[0].uri + ' ' + err;
            log.logMessage(message);
            clearInterval(this.intervalId);
            return reject(message);
          });
      }, 2000);
    });
  }

  getDeployLogs(deployResourceId){
    return new Promise((resolve) => {
      resolve(this._sendGACDRequest(this._getRequestOptions('/v2/deploys/:' + deployResourceId +
          '/logs', null),'get', 200, 'get deploy logs'));
    });
  }

  getDeployStatus(deployResourceId){
    return new Promise((resolve) => {
      resolve(this._sendGACDRequest(this._getRequestOptions('/v2/deploys/' +
          deployResourceId, null), 'get', 200, 'get deploy status'));
    });
  }

  _sendGACDRequest(options, method, expectedStatus, api){
    return new Promise((resolve,reject) => {
      let errMessage = null;
      log.logMessage('info','Sending request to ' + api);
      options.method = method;
      requestUtils.sendRequest(options, (err, res, body) => {
        if (res && res.statusCode === expectedStatus) {
          log.logMessage('info','Sending request to ' + api + ' completed succesfully');
          resolve(JSON.parse(body));
        } else {
          if (err) {
            errMessage = 'Error in request to ' + api + err.message;
          } else {
            errMessage = 'Error in request to ' + api + ' Status: ' + (res && res.statusCode) +
                ' Response: ' + body;
          }
          log.logMessage('error',errMessage);
          reject(errMessage);
        }
      });
    });
  }
  _getRequestOptions(path,body) {
    let corrID = uuid();
    let requestOptions = {
      url: this.service.credentials.uri + path,
      headers: {
        'Authorization': 'Bearer ' + this.token,
        'X-CorrelationID': corrID
      },
    };
    if (body) {
      requestOptions.body = body;
      requestOptions.maxContentLength = Infinity;
      requestOptions.maxBodyLength =  Infinity;
    }
    return requestOptions;
  }

  _getConfiguration() {
    let configuration = null;
    const services = xsenv.readServices();
    if (services) {
      configuration = {
        ['com.sap.service-credentials']: {}
      };
      for (let service in services) {
        const serviceName = services[service].label || service;
        log.logMessage('info',`Adding credentials for service ${serviceName}`);
        configuration['com.sap.service-credentials'][serviceName] = [services[service]];
      }
    }
    const destinations = process.env.BACKEND_DESTINATIONS || process.env.destinations;
    if (destinations){
      try {
        !configuration && (configuration = {});
        configuration.destinations = JSON.parse(destinations);
        log.logMessage('info','Adding destinations configuration');
      } catch (err){
        throw new Error('Failed to parse backend destinations ' + err);
      }
    }
    const iasDependencyName = process.env.IAS_DEPENDENCY_NAME;
    if (iasDependencyName){
      !configuration && (configuration = {});
      configuration.iasDependencyName = iasDependencyName;
      log.logMessage('info',`Adding IAS dependency name ${iasDependencyName}`);
    }
    const HTML5Runtime_enabled = process.env.HTML5Runtime_enabled;
    if (HTML5Runtime_enabled && HTML5Runtime_enabled === 'true'){
      !configuration && (configuration = {});
      configuration.HTML5Runtime_enabled = true;
      log.logMessage('info','Adding HTML5Runtime_enabled configuration');
    }
    return configuration;
  }
}

module.exports = GACDHandler;