/*
 * @copyright
 * Copyright © Microsoft Open Technologies, Inc.
 *
 * All Rights Reserved
 *
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at
 *
 * http: *www.apache.org/licenses/LICENSE-2.0
 *
 * THIS CODE IS PROVIDED *AS IS* BASIS, WITHOUT WARRANTIES OR CONDITIONS
 * OF ANY KIND, EITHER EXPRESS OR IMPLIED, INCLUDING WITHOUT LIMITATION
 * ANY IMPLIED WARRANTIES OR CONDITIONS OF TITLE, FITNESS FOR A
 * PARTICULAR PURPOSE, MERCHANTABILITY OR NON-INFRINGEMENT.
 *
 * See the Apache License, Version 2.0 for the specific language
 * governing permissions and limitations under the License.
 */
'use strict';

var request = require('request');
var url = require('url');
var _ = require('underscore');

var AADConstants = require('./constants').AADConstants;
var Logger = require('./log').Logger;
var util = require('./util');

/**
* Constructs an Authority object with a specific authority URL.
* @private
* @constructor
* @param {string}   authorityUrl        A URL that identifies a token authority.
* @param {bool}     validateAuthority   Indicates whether the Authority url should be validated as an actual AAD
*                                       authority.  The default is true.
*/
function Authority(authorityUrl, validateAuthority) {
  this._log = null;
  this._url = url.parse(authorityUrl);
  this._validateAuthorityUrl();

  this._validated = !validateAuthority;

  this._host = null;
  this._tenant = null;
  this._parseAuthority();

  this._authorizationEndpoint = null;
  this._tokenEndpoint = null;
}

/**
 * The URL of the authority
 * @instance
 * @type {string}
 * @memberOf Authority
 * @name url
 */
Object.defineProperty(Authority.prototype, 'url', {
  get: function() {
    return url.format(this._url);
  }
});

/**
 * The token endpoint that the authority uses as discovered by instance discovery.
 * @instance
 * @type {string}
 * @memberOf Authority
 * @name tokenEndpoint
 */
Object.defineProperty(Authority.prototype, 'tokenEndpoint', {
  get: function() {
    return this._tokenEndpoint;
  }
});

// This is fallback metadata in case the discovery endpoint is not available.
Authority.AAD_METADATA = '{"version":"1","instances":[{"id":"https://login.windows.net","endpoints":[{"location":"https://login.windows.net/{tenant}/oauth2/authorize","usage":"Auth20Authorize"},{"location":"https://login.windows.net/{tenant}/oauth2/token","usage":"Auth20Token"}]}]}';

/**
 * Checks the authority url to ensure that it meets basic requirements such as being over SSL.  If it does not then
 * this method will throw if any of the checks fail.
 * @private
 * @throws {Error} If the authority url fails to pass any validation checks.
 */
Authority.prototype._validateAuthorityUrl = function() {
  if (this._url.protocol !== 'https:') {
    throw new Error('The authority url must be an https endpoint.');
  }

  if (this._url.query) {
    throw new Error('The authority url must not have a query string.');
  }
};

/**
 * Parse the authority to get the tenant name.  The rest of the
 * URL is thrown away in favor of one of the endpoints from the validation doc.
 * @private
 */
Authority.prototype._parseAuthority = function() {
  this._host = this._url.host;

  var pathParts = this._url.pathname.split('/');
  this._tenant = pathParts[1];

  if (!this._tenant) {
    throw new Error('Could not determine tenant.');
  }
};

/**
 * Performs instance discovery based on a simple match against well known authorities.
 * @private
 * @return {bool}  Returns true if the authority is recognized.
 */
Authority.prototype._performStaticInstanceDiscovery = function() {
  this._log.verbose('Performing static instance discovery');

  var hostIndex = _.indexOf(AADConstants.WELL_KNOWN_AUTHORITY_HOSTS, this._url.hostname);
  var found = hostIndex > -1;

  if (found) {
    this._log.verbose('Authority validated via static instance discovery.');
  }

  return found;
};

Authority.prototype._createAuthorityUrl = function() {
  return 'https://' + this._url.host + '/' + this._tenant;
};

/**
 * Creates an instance discovery endpoint url for the specific authority that this object represents.
 * @private
 * @param  {string} authorityHost The host name of a well known authority.
 * @return {URL}    The constructed endpoint url.
 */
Authority.prototype._createInstanceDiscoveryEndpointFromTemplate = function(authorityHost) {
  var discoveryEndpoint = AADConstants.INSTANCE_DISCOVERY_ENDPOINT_TEMPLATE;
  discoveryEndpoint = discoveryEndpoint.replace('{authorize_host}', authorityHost);
  discoveryEndpoint = discoveryEndpoint.replace('{authorize_endpoint}', encodeURIComponent(this._createAuthorityUrl()));
  return url.parse(discoveryEndpoint);
};

/**
 * Performs instance discovery via a network call to well known authorities.
 * @private
 * @param {Authority.InstanceDiscoveryCallback}   callback    The callback function.  If succesful,
 *                                                            this function calls the callback with the
 *                                                            tenantDiscoveryEndpoint returned by the
 *                                                            server.
 */
Authority.prototype._performDynamicInstanceDiscovery = function(callback) {
  try {
    var self = this;
    var discoveryEndpoint = this._createInstanceDiscoveryEndpointFromTemplate(AADConstants.WORLD_WIDE_AUTHORITY);

    var getOptions = util.createRequestOptions(self);

    this._log.verbose('Attempting instance discover at: ' + url.format(discoveryEndpoint));
    request.get(discoveryEndpoint, getOptions, util.createRequestHandler('Instance Discovery', this._log, callback,
      function(response, body) {
        var discoveryResponse = JSON.parse(body);

        if (discoveryResponse['tenant_discovery_endpoint']) {
          callback(null, discoveryResponse['tenant_discovery_endpoint']);
        } else {
          callback(self._log.createError('Failed to parse instance discovery response'));
        }
      })
    );
  } catch(e) {
    callback(e);
  }
};

/**
 * @callback InstanceDiscoveryCallback
 * @private
 * @memberOf Authority
 * @param {Error} err If an error occurs during instance discovery then it will be returned here.
 * @param {string} tenantDiscoveryEndpoint If instance discovery is successful then this will contain the
 *                                         tenantDiscoveryEndpoint associated with the authority.
 */

/**
 * Determines whether the authority is recognized as a trusted AAD authority.
 * @private
 * @param {Authority.InstanceDiscoveryCallback}   callback    The callback function.
 */
Authority.prototype._validateViaInstanceDiscovery = function(callback) {
  if (this._performStaticInstanceDiscovery()) {
    callback();
  } else {
    this._performDynamicInstanceDiscovery(callback);
  }
};

/**
 * @callback GetOauthEndpointsCallback
 * @private
 * @memberOf Authority
 * @param {Error} error An error if one occurred.
 */

/**
 * Given a tenant discovery endpoint this method will attempt to discover the token endpoint.  If the
 * tenant discovery endpoint is unreachable for some reason then it will fall back to a algorithmic generation of the
 * token endpoint url.
 * @private
 * @param {string}           tenantDiscoveryEndpoint   The url of the tenant discovery endpoint for this authority.
 * @param {Authority.GetOauthEndpointsCallback}  callback  The callback function.
 */
Authority.prototype._getOAuthEndpoints = function(tenantDiscoveryEndpoint, callback) {
  if (this._tokenEndpoint) {
    callback();
    return;
  } else {
    // fallback to the well known token endpoint path.
    this._tokenEndpoint = url.format(this._url) + AADConstants.TOKEN_ENDPOINT_PATH;
    callback();
    return;
  }
};

/**
 * @callback ValidateCallback
 * @memberOf Authority
 */

/**
 * Perform validation on the authority represented by this object.  In addition to simple validation
 * the oauth token endpoint will be retrieved.
 * @param {Authority.ValidateCallback}   callback   The callback function.
 */
Authority.prototype.validate = function(callContext, callback) {
  this._log = new Logger('Authority', callContext._logContext);
  this._callContext = callContext;
  var self = this;

  if (!this._validated) {
    this._log.verbose('Performing instance discovery: ' + url.format(this._url));
    this._validateViaInstanceDiscovery(function(err, tenantDiscoveryEndpoint) {
      if (err)
      {
        callback(err);
      } else {
        self._validated = true;
        self._getOAuthEndpoints(tenantDiscoveryEndpoint, callback);
        return;
      }
    });
  } else {
    this._log.verbose('Instance discovery/validation has either already been completed or is turned off: ' + url.format(this._url));
    this._getOAuthEndpoints(null, callback);
    return;
  }
};

module.exports.Authority = Authority;
