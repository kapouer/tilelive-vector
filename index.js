var mapnik = require('mapnik');
var zlib = require('zlib');
var path = require('path');
var util = require('util');

module.exports = Vector;

function Task() {
    this.err = null;
    this.headers = {};
    this.access = +new Date;
    this.done;
    this.body;
    return;
};
util.inherits(Task, require('events').EventEmitter);

function Vector(uri, callback) {
    if (!uri.backend) return callback && callback(new Error('No datatile backend'));
    if (!uri.xml) return callback && callback(new Error('No xml'));

    this._uri = uri;
    this._scale = uri.scale || 1;
    this._format = uri.format || 'png8:m=h';
    this._maxAge = typeof uri.maxAge === 'number' ? uri.maxAge : 300e3;
    this._deflate = typeof uri.deflate === 'boolean' ? uri.deflate : true;
    this._reap = typeof uri.reap === 'number' ? uri.reap : 60e3;
    this._base = path.resolve(uri.base || __dirname);

    if (callback) this.once('open', callback);

    this.update(uri, function(err) {
        this.emit('open', err, this);
    }.bind(this));
};
util.inherits(Vector, require('events').EventEmitter);

// Helper for callers to ensure source is open. This is not built directly
// into the constructor because there is no good auto cache-keying system
// for these tile sources (ie. sharing/caching is best left to the caller).
Vector.prototype.open = function(callback) {
    if (this._map) return callback(null, this);
    this.once('open', callback);
};

// Allows in-place update of XML/backends.
Vector.prototype.update = function(opts, callback) {
    // If the backend has changed, the datatile cache must be cleared.
    if (opts.backend && this._backend !== opts.backend) {
        opts.backend._vectorCache = {};
        this._backend = opts.backend;
        delete this._minzoom;
        delete this._maxzoom;
        delete this._maskLevel;
    }
    // If the XML has changed update the map.
    if (opts.xml && this._xml !== opts.xml) {
        var map = new mapnik.Map(256,256);
        map.fromString(opts.xml, {
            strict: false,
            base: this._base + '/'
        }, function(err) {
            delete this._info;
            this._xml = opts.xml;
            this._map = map;
            return callback(err);
        }.bind(this));
        return;
    }
    return callback();
};

// Wrapper around backend.getTile that implements a "locking" cache.
Vector.prototype.sourceTile = function(backend, z, x, y, callback) {
    var source = this;
    var now = +new Date;
    var key = z + '/' + x + '/' + y;
    var cache = backend._vectorCache[key];

    // Reap cached vector tiles with stale access times on an interval.
    if (source._reap && !backend._vectorTimeout) backend._vectorTimeout = setTimeout(function() {
        var now = +new Date;
        Object.keys(backend._vectorCache).forEach(function(key) {
            if ((now - backend._vectorCache[key].access) < source._maxAge) return;
            delete backend._vectorCache[key];
        });
        delete backend._vectorTimeout;
    }, source._reap);

    // Expire cached tiles when they are past maxAge.
    if (cache && (now-cache.access) >= source._maxAge) cache = false;

    // Return cache if finished.
    if (cache && cache.done) {
        cache.access = now;
        return callback(null, cache.body, cache.headers);
    // Otherwise add listener if task is in progress.
    } else if (cache) {
        return cache.once('done', callback);
    }

    var task = new Task();
    task.once('done', callback);

    var done = function(err, body, headers) {
        if (err) delete backend._vectorCache[key];
        task.done = true;
        task.body = body;
        task.headers = headers;
        task.emit('done', err, body, headers);
    };
    backend._vectorCache[key] = task;
    backend.getTile(z, x, y, function(err, body, headers) {
        if (err) return done(err);

        // If the source vector tiles are not using deflate, we're done.
        if (!source._deflate) return done(err, body, headers);

        // Otherwise, inflate the data.
        zlib.inflate(body, function(err, body) { return done(err, body, headers); });
    });
};

Vector.prototype.drawTile = function(bz, bx, by, z, x, y, callback) {
    var source = this;
    source.sourceTile(this._backend, bz, bx, by, function(err, data, headers) {
        if (err && err.message !== 'Tile does not exist')
            return callback(err);

        if (err && source._maskLevel && bz > source._maskLevel)
            return callback(err);

        var datatile = new mapnik.DataTile(bz, bx, by);
        datatile.setData(data || new Buffer(0), function(err, success) {
            var opts = {z:z, x:x, y:y, scale:source._scale};
            datatile.render(source._map, new mapnik.Image(256,256), opts, function(err, image) {
                if (err) return callback(err);
                image.encode(source._format, {}, function(err, buffer) {
                    if (err) return callback(err);
                    // @TODO determine headers from source format.
                    return callback(null, buffer, {'Content-Type': 'image/png'});
                });
            });
        });
    });
};

Vector.prototype.getTile = function(z, x, y, callback) {
    if (!this._map) return callback(new Error('Tilesource not loaded'));

    // Lazy load min/maxzoom/maskLevel info.
    if (this._maxzoom === undefined) return this._backend.getInfo(function(err, info) {
        if (err) return callback(err);

        this._minzoom = info.minzoom || 0;
        this._maxzoom = info.maxzoom || 22;

        // @TODO massive hack to avoid conflict with tilelive-s3's
        // interpretation of 'maskLevel' key. Fix this by removing
        // masking entirely from the next version of tilelive-s3.
        if (this._backend.data && this._backend.data.maskLevel) {
            this._backend.data._maskLevel = this._backend.data.maskLevel;
            delete this._backend.data.maskLevel;
        }
        if (this._backend.data && this._backend.data._maskLevel) {
            this._maskLevel = this._backend.data._maskLevel;
        }

        return this.getTile(z, x, y, callback);
    }.bind(this));

    // If scale > 1 adjusts source data zoom level inversely.
    // scale 2x => z-1, scale 4x => z-2, scale 8x => z-3, etc.
    var d = Math.round(Math.log(this._scale)/Math.log(2));
    var bz = (z - d) > this._minzoom ? z - d : this._minzoom;
    var bx = Math.floor(x / Math.pow(2, z - bz));
    var by = Math.floor(y / Math.pow(2, z - bz));

    // Overzooming support.
    if (bz > this._maxzoom) {
        bz = this._maxzoom;
        bx = Math.floor(x / Math.pow(2, z - this._maxzoom));
        by = Math.floor(y / Math.pow(2, z - this._maxzoom));
    }

    // For nonmasked sources or bz within the maskrange attempt 1 draw.
    if (!this._maskLevel || bz <= this._maskLevel)
        return this.drawTile(bz,bx,by,z,x,y,callback);

    // Above the maskLevel errors should attempt a second draw using the mask.
    this.drawTile(bz,bx,by,z,x,y, function(err, buffer, headers) {
        if (!err) return callback(err, buffer, headers);
        if (err && err.message !== 'Tile does not exist') return callback(err);
        bz = this._maskLevel;
        bx = Math.floor(x / Math.pow(2, z - this._maskLevel));
        by = Math.floor(y / Math.pow(2, z - this._maskLevel));
        this.drawTile(bz, bx, by, z, x, y, callback);
    }.bind(this));
};

Vector.prototype.getInfo = function(callback) {
    if (!this._map) return callback(new Error('Tilesource not loaded'));
    if (this._info) return callback(null, this._info);

    var params = this._map.parameters;
    this._info = Object.keys(params).reduce(function(memo, key) {
        switch (key) {
        case 'bounds':
        case 'center':
            memo[key] = params[key].split(',').map(function(v) { return parseFloat(v) });
            break;
        case 'minzoom':
        case 'maxzoom':
            memo[key] = parseInt(params[key], 10);
            break;
        default:
            memo[key] = params[key];
            break;
        }
        return memo;
    }, {});
    return callback(null, this._info);
};

