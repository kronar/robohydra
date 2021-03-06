var fs     = require('fs'),
    url    = require('url'),
    assert = require('assert');
var heads               = require('./heads'),
    HydraHead           = heads.HydraHead,
    HydraHeadStatic     = heads.HydraHeadStatic,
    HydraHeadFilesystem = heads.HydraHeadFilesystem,
    HydraHeadProxy      = heads.HydraHeadProxy;
var utils              = require('./utils.js'),
    serveStaticFile    = utils.serveStaticFile,
    proxyRequest       = utils.proxyRequest,
    Request            = utils.Request,
    Response           = utils.Response;
var exceptions         = require('./exceptions.js'),
    RoboHydraException = exceptions.RoboHydraException,
    DuplicateRoboHydraHeadNameException =
        exceptions.DuplicateRoboHydraHeadNameException,
    DuplicateRoboHydraPluginException =
        exceptions.DuplicateRoboHydraPluginException,
    InvalidRoboHydraPluginException =
        exceptions.InvalidRoboHydraPluginException,
    RoboHydraPluginNotFoundException =
        exceptions.RoboHydraPluginNotFoundException,
    InvalidRoboHydraNextParametersException =
        exceptions.InvalidRoboHydraNextParametersException,
    RoboHydraHeadNotFoundException =
        exceptions.RoboHydraHeadNotFoundException,
    InvalidRoboHydraTestException =
        exceptions.InvalidRoboHydraTestException;




var RoboHydra = function(config) {
    this._plugins    = [];
    this._headMap    = {};
    this.currentTest = {plugin: '*default*',
                        test:   '*default*'};
    this._pluginLoadPath = ['robohydra/plugins',
                            'node_modules/robohydra/plugins',
                            '/usr/local/share/robohydra/plugins',
                            '/usr/share/robohydra/plugins'];
    this.testResults = {'*default*': {'*default*': {result: undefined,
                                                    passes: [],
                                                    failures: []}}};

    // Register special plugins
    // Admin
    var adminPlugin = require('./plugins/admin.js');
    var adminPluginConfig = {};
    for (var p in config) { adminPluginConfig[p] = config[p]; }
    adminPluginConfig.robohydra = this;
    adminPlugin.heads = adminPlugin.getBodyParts(adminPluginConfig);
    this._registerPluginObject(adminPlugin);
    // Dynamic heads
    this._registerPluginObject({name: '*dynamic*', heads: []});
    // Current test heads
    this._registerPluginObject({name: '*current-test*', heads: []});
};
RoboHydra.prototype._validatePluginName = function(pluginName) {
    return (typeof(pluginName) === 'string' &&
                pluginName.match(new RegExp('^[a-z0-9_-]+$', 'i')));
};
RoboHydra.prototype._addHeadsToPluginStructure = function(heads, pluginStructure) {
    var anonymousHeadCount = 0;
    heads.forEach(function(head) {
        // Calculate head name if not specified
        if (head.name === undefined) {
            head.name = 'anonymousHead' + anonymousHeadCount;
            anonymousHeadCount++;
            while (pluginStructure.headMap.hasOwnProperty(head.name)) {
                head.name = 'anonymousHead' + anonymousHeadCount;
                anonymousHeadCount++;
            }
        }

        if (pluginStructure.headMap.hasOwnProperty(head.name)) {
            throw new DuplicateRoboHydraHeadNameException(head.name);
        }
        pluginStructure.headMap[head.name] = head;
    });
};
RoboHydra.prototype._registerPluginObject = function(plugin) {
    var name = plugin.name;
    if (this._plugins.some(function(v) { return v.plugin.name === name; })) {
        throw new DuplicateRoboHydraPluginException();
    }

    var pluginToRegister = {
        name:  plugin.name,
        heads: plugin.heads || [],
        tests: plugin.tests || {}
    };

    var pluginInternalStructure = {headMap: {}, plugin: pluginToRegister};
    this._addHeadsToPluginStructure(pluginToRegister.heads,
                                    pluginInternalStructure);
    this._plugins.push(pluginInternalStructure);
};
RoboHydra.prototype.registerPluginObject = function(plugin) {
    if (! this._validatePluginName(plugin.name)) {
        throw new InvalidRoboHydraPluginException("Invalid plugin name '" +
                                                      plugin.name + "'");
    }
    var hasHeads = (typeof plugin.heads === 'object') && plugin.heads.length;
    var hasTests = false;
    if (typeof(plugin.tests) === 'object') {
        for (var t in plugin.tests) {
            if (plugin.tests.hasOwnProperty(t)) { hasTests = true; }
        }
    }
    if (!hasHeads && !hasTests) {
        throw new InvalidRoboHydraPluginException("Plugin doesn't have any heads or tests");
    }

    this._registerPluginObject(plugin);
};
RoboHydra.prototype.registerDynamicHead = function(head) {
    var done = false;
    for (var i = 0, len = this._plugins.length; i < len; i++) {
        if (this._plugins[i].plugin.name === '*dynamic*') {
            this._addHeadsToPluginStructure([head], this._plugins[i]);
            this._plugins[i].plugin.heads.push(head);
            done = true;
        }
    }
    if (! done) {
        throw "Internal error: couldn't find the dynamic head plugin";
    }
};
RoboHydra.prototype.getPluginNames = function() {
    return this.getPlugins().map(function(p) { return p.name; });
};
RoboHydra.prototype.getPlugins = function() {
    return this._plugins.map(function(v) { return v.plugin; });
};
RoboHydra.prototype.getPlugin = function(pluginName) {
    var pluginList = this._plugins.filter(function(p) {
                         return p.plugin.name === pluginName;
                     });
    if (pluginList.length) {
        return pluginList[0].plugin;
    }
    throw new RoboHydraPluginNotFoundException(pluginName);
};
RoboHydra.prototype.headForPath = function(url, afterHead) {
    var canMatch = !afterHead;
    for (var i = 0, len = this._plugins.length; i < len; i++) {
        var plugin = this._plugins[i].plugin;
        for (var j = 0, len2 = plugin.heads.length; j < len2; j++) {
            if (canMatch && plugin.heads[j].canHandle(url)) {
                return {plugin: plugin, head: plugin.heads[j]};
            }

            if (typeof afterHead === 'object' &&
                    this._plugins[i].plugin.name === afterHead.plugin.name &&
                    plugin.heads[j].name  === afterHead.head.name) {
                canMatch = true;
            }
        }
    }
    return undefined;
};
RoboHydra.prototype.handle = function(req, res, afterHead) {
    var r = this.headForPath(req.url, afterHead);
    if (r !== undefined) {
        res.statusCode = 200;
        try {
            var self = this;
            r.head.handle(req, res, function(req2, res2) {
                if (arguments.length !== 2) {
                    throw new InvalidRoboHydraNextParametersException(
                        r.plugin,
                        r.head,
                        arguments
                    );
                }
                self.handle(req2, res2, r);
            });
        } catch (e) {
            if (e instanceof assert.AssertionError) {
                res.end();
            } else {
                throw e;
            }
        }
    } else {
        res.statusCode = 404;
        res.send("Not Found");
    }
};
RoboHydra.prototype.findHead = function(pluginName, headName) {
    for (var i = 0, len = this._plugins.length; i < len; i++) {
        if (this._plugins[i].plugin.name === pluginName) {
            var head = this._plugins[i].headMap[headName];
            if (head === undefined) {
                throw new RoboHydraHeadNotFoundException(pluginName, headName);
            } else {
                return head;
            }
        }
    }
    throw new RoboHydraHeadNotFoundException(pluginName, headName);
};
RoboHydra.prototype.isHeadAttached = function(pluginName, headName) {
    // This will throw an exception if the head is not found
    var head = this.findHead(pluginName, headName);
    return head.attached();
};
RoboHydra.prototype.detachHead = function(pluginName, headName) {
    this.findHead(pluginName, headName).detach();
};
RoboHydra.prototype.attachHead = function(pluginName, headName) {
    this.findHead(pluginName, headName).attach();
};
RoboHydra.prototype.addPluginLoadPath = function(path) {
    this._pluginLoadPath.unshift(path);
};
// Return an object with keys 'module', 'config' and 'name'. The
// 'config' value is another object with keys 'path', 'robohydra' and
// any other values from the configuration. It throws an exception
// RoboHydraPluginNotFoundException if the plugin could not be found
RoboHydra.prototype.requirePlugin = function(name, config, opts) {
    opts = opts || {};
    var rootDir = opts.rootDir ? fs.realpathSync(opts.rootDir) : '';
    var plugin = {};
    var stat, fullPath;
    for (var i = 0, len = this._pluginLoadPath.length; i < len; i++) {
        try {
            fullPath = rootDir +
                (this._pluginLoadPath[i].indexOf('/') !== 0 ?
                     fs.realpathSync('.') + '/' : '') +
                this._pluginLoadPath[i] + '/' + name;
            stat = fs.statSync(fullPath);
        } catch (e) {
            // It's ok if the plugin is not in this directory
            if (e.code !== 'ENOENT') {
                throw e;
            }
        }
        if (stat && stat.isDirectory()) {
            plugin.module = require(fullPath);
            break;
        }
    }
    if (plugin.module) {
        plugin.config = {robohydra: this, path: fullPath};
        for (var p in config) { plugin.config[p] = config[p]; }
        return plugin;
    } else {
        throw new RoboHydraPluginNotFoundException(name);
    }
};
RoboHydra.prototype.startTest = function(pluginName, testName) {
    this.stopTest();

    var found = false;
    var testPlugin, i, len;
    for (i = 0, len = this._plugins.length; i < len; i++) {
        if (this._plugins[i].plugin.name === pluginName) {
            if (this._plugins[i].plugin.tests.hasOwnProperty(testName)) {
                testPlugin = this._plugins[i].plugin;
                this.currentTest = {plugin: pluginName, test: testName};
                found = true;
            }
        }
    }

    if (found) {
        var done = false;
        for (i = 0, len = this._plugins.length; i < len; i++) {
            if (this._plugins[i].plugin.name === '*current-test*') {
                var heads = testPlugin.tests[testName].heads;
                this._addHeadsToPluginStructure(heads, this._plugins[i]);
                Array.prototype.push.apply(this._plugins[i].plugin.heads,
                                           heads);
                done = true;
            }
        }
        if (done) {
            this.testResults[pluginName] = this.testResults[pluginName] || {};
            this.testResults[pluginName][testName] = {result: undefined,
                                                      passes: [],
                                                      failures: []};
        } else {
            throw "Internal error: couldn't find the current test plugin";
        }
    } else {
        throw new InvalidRoboHydraTestException(pluginName, testName);
    }
};
RoboHydra.prototype.stopTest = function() {
    this.currentTest = {plugin: '*default*', test: '*default*'};

    for (var i = 0, len = this._plugins.length; i < len; i++) {
        if (this._plugins[i].plugin.name === '*current-test*') {
            this._plugins[i] = {headMap: {},
                                plugin: {name: '*current-test*', heads: []}};
        }
    }
};
RoboHydra.prototype.getAssertionFunction = function(assertion) {
    var thisRoboHydra = this;
    return function() {
        var currentTestPlugin = thisRoboHydra.currentTest.plugin,
            currentTestName   = thisRoboHydra.currentTest.test;
        var result =
            thisRoboHydra.testResults[currentTestPlugin][currentTestName];

        var assertionFunction = assert[assertion];
        var message = arguments[assertionFunction.length-1] ||
            "*unnamed-assertion*";

        try {
            assertionFunction.apply(assert, arguments);

            result.passes.push(message);
            result.result = result.result || 'pass';
        }
        catch (e) {
            if (e instanceof assert.AssertionError) {
                result.failures.push(message);
                result.result = 'fail';
            }
            throw e;
        }
    };
};
RoboHydra.prototype.getModulesObject = function() {
    var utilsObject = {assert: {}};

    for (var assertion in assert) {
        if (assert.hasOwnProperty(assertion) && typeof assert[assertion] === 'function') {
            utilsObject.assert[assertion] =
                this.getAssertionFunction(assertion);
        }
    }

    return utilsObject;
};


exports.RoboHydra       = RoboHydra;
exports.Request         = Request;
exports.Response        = Response;
exports.serveStaticFile = serveStaticFile;
exports.proxyRequest    = proxyRequest;
exports.heads           = heads;
exports.RoboHydraException = RoboHydraException;
for (var exception in exceptions) {
    exports[exception] = exceptions[exception];
}
