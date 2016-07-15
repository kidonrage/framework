// jscs:disable requireCamelCaseOrUpperCaseIdentifiers
/**
 * Created by Vasiliy Ermilov (email: inkz@xakep.ru, telegram: @inkz1) on 29.04.16.
 */
'use strict';

var DataRepositoryModule = require('core/interfaces/DataRepository');
var DataRepository = DataRepositoryModule.DataRepository;
var Item = DataRepositoryModule.Item;
var PropertyTypes = require('core/PropertyTypes');
var EventType = require('core/interfaces/ChangeLogger').EventType;
var uuid = require('node-uuid');

/* jshint maxstatements: 40, maxcomplexity: 40 */
/**
 * @param {DataSource} datasource
 * @param {MetaRepository} metarepository
 * @param {KeyProvider} keyProvider
 * @constructor
 */
function IonDataRepository(datasource, metarepository, keyProvider) {
  var _this = this;
  /**
   * @type {DataSource}
   */
  this.ds = datasource;

  /**
   * @type {MetaRepository}
   */
  this.meta = metarepository;

  /**
   * @type {KeyProvider}
   */
  this.keyProvider = keyProvider;

  this.namespaceSeparator = '__';

  /**
   *
   * @param {ClassMeta} cm
   * @returns {String}
   */
  function tn(cm) {
    return (cm.getNamespace() ? cm.getNamespace() + _this.namespaceSeparator : '') + cm.getName();
  }

  /**
   *
   * @param {Object[]} validators
   * @returns {Promise}
   */
  this._setValidators = function (validators) {
    return new Promise(function (resolve, reject) { resolve(); });
  };

  /**
   * @param {String | Item} obj
   * @private
   * @returns {ClassMeta | null}
   */
  this._getMeta = function (obj) {
    if (typeof obj === 'string') {
      return this.meta.getMeta(obj);
    } else if (typeof obj === 'object' && obj.constructor.name === 'Item') {
      return obj.classMeta;
    }
    return null;
  };

  /**
   * @param {ClassMeta} cm
   * @private
   * @returns {ClassMeta}
   */
  this._getRootType = function (cm) {
    if (cm.ancestor) {
      return this._getRootType(cm.ancestor);
    }
    return cm;
  };

  /**
   * @param {Object} filter
   * @param {ClassMeta} cm
   * @private
   */
  this._addDiscriminatorFilter = function (filter, cm) {
    var descendants = this.meta.listMeta(cm.getName(), cm.getVersion(), false, cm.getNamespace());
    var cnFilter = [cm.getCanonicalName()];
    for (var i = 0; i < descendants.length; i++) {
      cnFilter[cnFilter.length] = descendants[i].getCanonicalName();
    }

    if (!filter) {
      return {_class: {$in: cnFilter}};
    } else {
      return {$and: [filter, {_class: {$in: cnFilter}}]};
    }
  };

  /**
   * @param {Object} filter
   * @param {Item} item
   * @returns {Object}
   * @private
   */
  this._addFilterByItem = function (filter, item) {
    if (typeof item === 'object' && item.constructor.name === 'Item') {
      var conditions, props;
      conditions = [filter];
      props = item.getProperties();
      for (var nm in props) {
        if (item.base.hasOwnProperty(nm)) {
          var c = {};
          c[nm] = item.base[nm];
          conditions[conditions.length] = c;
        }
      }
      return {$and: conditions};
    }
    return filter;
  };

  /**
   * @param {String} className
   * @param {Object} data
   * @param {String} [version]
   * @private
   * @returns {Item | null}
   */
  this._wrap = function (className, data, version) {
    var acm = this.meta.getMeta(className, version);
    return new Item(this.keyProvider.formKey(acm.getName(), data, acm.getNamespace()), data, acm, this);
  };

  /**
   *
   * @param {String | Item} obj
   * @param {{filter: Object}} [options]
   * @returns {Promise}
   */
  this._getCount  = function (obj, options) {
    if (!options) {
      options = {};
    }
    var cm = this._getMeta(obj);
    var rcm = this._getRootType(cm);
    options.filter = this._addFilterByItem(options.filter, obj);
    options.filter = this._addDiscriminatorFilter(options.filter, cm);
    return this.ds.count(tn(rcm), options);
  };

  /**
   * @param {Item} item
   * @param {Property} property
   * @param {{}} attrs
   */
  function prepareRefEnrichment(item, property, attrs) {
    var refc = _this.meta.getMeta(property.meta.ref_class, null, item.classMeta.getNamespace());
    if (refc) {
      if (!attrs.hasOwnProperty(item.classMeta.getName() + '.' + property.getName())) {
        attrs[item.classMeta.getName() + '.' + property.getName()] = {
          type: PropertyTypes.REFERENCE,
          refClassName: refc.getCanonicalName(),
          attrName: property.getName(),
          key: refc.getKeyProperties()[0],
          pIndex: 0,
          filter: []
        };
      }

      var v = item.get(property.getName());
      if (v) {
        attrs[item.classMeta.getName() + '.' + property.getName()].filter.push(v);
        if (typeof item.references === 'undefined') {
          item.references = {};
        }
      }
    }
  }

  /**
   * @param {Item} item
   * @param {Property} property
   * @param {{}} attrs
   */
  function prepareColEnrichment(item, property, attrs) {
    var refc = _this.meta.getMeta(property.meta.items_class, null, item.classMeta.getNamespace());
    if (refc) {
      if (!attrs.hasOwnProperty(item.classMeta.getName() + '.' + property.getName())) {
        attrs[item.classMeta.getName() + '.' + property.getName()] = {
          type: PropertyTypes.COLLECTION,
          colClassName: refc.getCanonicalName(),
          attrName: property.getName(),
          key: refc.getKeyProperties()[0],
          backRef: property.meta.back_ref,
          pIndex: 0,
          colItems: []
        };
      }

      if (property.meta.back_ref && !property.meta.back_coll) {
        attrs[item.classMeta.getName() + '.' + property.getName()].colItems.push(item.getItemId());
      } else {
        var v = item.get(property.getName());
        if (v) {
          attrs[item.classMeta.getName() + '.' + property.getName()].colItems =
            attrs[item.classMeta.getName() + '.' + property.getName()].colItems.concat(v);
        }
      }
      if (typeof item.collections === 'undefined') {
        item.collections = [];
      }
    }
  }

  /**
   * @param {Array} src
   * @param {Number} depth
   * @returns {Promise}
   */
  function enrich(src, depth) {
    var i, nm, attrs, item, props, promises, filter, cn;

    attrs = {};
    promises = [];
    if (depth <= 0) {
      return new Promise(function (resolve, reject) {
        resolve(src);
      });
    }

    for (i = 0; i < src.length; i++) {
      item = src[i];
      props = item.getProperties();
      for (nm in props) {
        if (props.hasOwnProperty(nm)) {
          if (props[nm].getType() === PropertyTypes.REFERENCE) {
            prepareRefEnrichment(item, props[nm], attrs);
          } else if (props[nm].getType() === PropertyTypes.COLLECTION && props[nm].meta.eager_loading) {
            prepareColEnrichment(item, props[nm], attrs);
          }
        }
      }
    }

    promises = [];

    i = 0;
    for (nm in attrs) {
      if (attrs.hasOwnProperty(nm)) {
        attrs[nm].pIndex = i;
        i++;
        filter = {};

        if (attrs[nm].type  === PropertyTypes.REFERENCE) {
          filter[attrs[nm].key] = {$in: attrs[nm].filter};
          cn = attrs[nm].refClassName;
        } else if (attrs[nm].type  === PropertyTypes.COLLECTION) {
          filter[attrs[nm].backRef ? attrs[nm].backRef : attrs[nm].key] = {$in: attrs[nm].colItems};
          cn = attrs[nm].colClassName;
        }

        promises.push(_this.getList(cn, {
          filter: filter,
          nestingDepth: depth - 1
        }));

      }
    }

    if (promises.length === 0) {
      return new Promise(function (resolve, reject) {
        resolve(src);
      });
    }

    return new Promise(function (resolve, reject) {
      Promise.all(promises).then(
        function (results) {
          var nm, items, itemsByKey, srcByKey, ids, i;
          for (nm in attrs) {
            if (attrs.hasOwnProperty(nm)) {
              items = results[attrs[nm].pIndex];
              if (items.length === 0) {
                continue;
              }
              if (attrs[nm].type === PropertyTypes.REFERENCE) {
                itemsByKey = {};
                for (i = 0; i < items.length; i++) {
                  itemsByKey[items[i].getItemId()] = items[i];
                }

                for (i = 0; i < src.length; i++) {
                  if (itemsByKey.hasOwnProperty(src[i].base[attrs[nm].attrName])) {
                    src[i].references[attrs[nm].attrName] = itemsByKey[src[i].base[attrs[nm].attrName]];
                  }
                }
              } else if (attrs[nm].type === PropertyTypes.COLLECTION) {
                if (attrs[nm].backRef) {
                  if (!srcByKey) {
                    srcByKey = {};

                    for (i = 0; i < src.length; i++) {
                      srcByKey[src[i].getItemId()] = src[i];
                    }
                  }

                  for (i = 0; i < items.length; i++) {
                    if (srcByKey.hasOwnProperty(items[i].base[attrs[nm].backRef])) {
                      if (typeof srcByKey[items[i].base[attrs[nm].backRef]].
                          collections[attrs[nm].attrName] === 'undefined') {
                        srcByKey[items[i].base[attrs[nm].backRef]].collections[attrs[nm].attrName] = [];
                      }
                      srcByKey[items[i].base[attrs[nm].backRef]].collections[attrs[nm].attrName].push(items[i]);
                    }
                  }
                } else {
                  itemsByKey = {};
                  for (i = 0; i < items.length; i++) {
                    itemsByKey[items[i].getItemId()] = items[i];
                  }
                  for (i = 0; i < src.length; i++) {
                    ids = src[i].get(attrs[nm].attrName) || [];
                    src[i].collections[attrs[nm].attrName] = [];
                    for (i = 0; i < ids.length; i++) {
                      if (itemsByKey.hasOwnProperty(ids[i])) {
                        src[i].collections[attrs[nm].attrName].push(itemsByKey[ids[i]]);
                      }
                    }
                  }
                }
              }
            }
          }
          resolve(src);
        }
      ).catch(reject);
    });
  }

  /**
   *
   * @param {String | Item} obj
   * @param {Object} [options]
   * @param {Object} [options.filter]
   * @param {Number} [options.offset]
   * @param {Number} [options.count]
   * @param {Object} [options.sort]
   * @param {Boolean} [options.countTotal]
   * @param {Number} [options.nestingDepth]
   * @returns {Promise}
   */
  this._getList = function (obj, options) {
    if (!options) {
      options = {};
    }
    var cm = this._getMeta(obj);
    var rcm = this._getRootType(cm);
    options.filter = this._addFilterByItem(options.filter, obj);
    options.filter = this._addDiscriminatorFilter(options.filter, cm);
    return new Promise(function (resolve, reject) {
      var result = [];
      _this.ds.fetch(rcm.getName(), options).
        then(function (data) {
          try {
            for (var i = 0; i < data.length; i++) {
              result[i] = _this._wrap(data[i]._class, data[i], data[i]._classVer);
            }
          } catch (err) {
            return reject(err);
          }

          if (typeof data.total !== 'undefined' && data.total !== null) {
            result.total = data.total;
          }
          return enrich(result, options.nestingDepth ? options.nestingDepth : 0);
        }).
        then(resolve).
        catch(reject);
    });
  };

  /**
   *
   * @param {String | Item} obj
   * @param {String} [id]
   * @param {Number} [nestingDepth]
   */
  this._getItem = function (obj, id, nestingDepth) {
    var cm = this._getMeta(obj);
    var rcm = this._getRootType(cm);
    if (id) {
      return new Promise(function (resolve, reject) {
        _this.ds.get(tn(rcm), _this.keyProvider.keyToData(rcm.getName(), id, rcm.getNamespace())).
        then(function (data) {
          var result = [];
          if (data) {
            result.push(_this._wrap(data._class, data, data._classVer));
          }
          try {
            return enrich(result, nestingDepth ? nestingDepth : 0);
          } catch (err) {
            reject(err);
          }
        }).then(function (items) { resolve(items[0]); }).catch(reject);
      });
    } else {
      var options = {};
      options.filter = this._addFilterByItem({}, obj);
      options.filter = this._addDiscriminatorFilter(options.filter, cm);
      options.count = 1;
      return new Promise(function (resolve, reject) {
        _this.ds.fetch(tn(rcm), options).then(function (data) {
          var result = [];
          for (var i = 0; i < data.length; i++) {
            result[i] = _this._wrap(data[i]._class, data[i], data[i]._classVer);
          }
          return enrich(result);
        }).then(function (items) { resolve(items[0]); }).catch(reject);
      });
    }
  };

  /*
  Данный метод на будущее - если будет реализовываться редактирование вложенных объектов

   * @param {Item} item
   * @param {{}} values
   * @param {ChangeLogger} [logger]

  function processRefItems(item,values,logger) {
    var updates = {};

    for (var key in values) {
      if (values.hasOwnProperty(key) && key.indexOf('.') > -1) {
        var splittedKey = key.split('.');
        var ref = splittedKey[0];
        var nm = splittedKey[1];
        if (!updates.hasOwnProperty(ref)) {
          updates[ref] = {};
        }
        updates[ref][nm] = values[key];
      }
    }

    for (var refProperty in updates) {
      if (updates.hasOwnProperty(refProperty)) {
        var p = item.property(refProperty);
        if (p && p.getType() === PropertyTypes.REFERENCE) {
          var v = p.getValue();
          var refc = _this.meta.getMeta(rp.ref_class, null, item.classMeta.getNamespace());
          var rp = p.getMeta();
          if (v) {
            _this.editItem(cn(refc), v, updates[refProperty], logger);
          } else {
            var ri = _this.createItem(cn(refc), updates[refProperty], logger);
            values[refProperty] = ri.getItemId();
          }
        }
      }
    }
    return values;
  }
  */

  /* jshint maxcomplexity: 20 */
  /**
   * @param {*} value
   * @param {{ type: Number, ref_class: String }} pm
   * @param {String} ns
   * @returns {*}
   */
  function castValue(value, pm, ns) {
    if (pm.type === PropertyTypes.REFERENCE) {
      var refcm = _this.meta.getMeta(pm.ref_class, ns);
      var refkey = refcm.getPropertyMeta(refcm.getKeyProperties()[0]);
      if (refkey) {
        return castValue(value, refkey);
      }
      return value;
    }

    if (pm.type === PropertyTypes.STRING && value !== null) {
      return value;
    }
    switch (pm.type){
      case PropertyTypes.BOOLEAN: {
        if (value === 'false') {
          return false;
        } else {
          return Boolean(value);
        }
      }break;
      case PropertyTypes.DATETIME: return new Date(value);
      case PropertyTypes.REAL:
      case PropertyTypes.DECIMAL: return parseFloat(value);
      case PropertyTypes.SET:
      case PropertyTypes.INT: return parseInt(value);
    }
    return value;
  }

  function processManyToManyCollection(itemId,value,backColPropertyName,backColCm){
    return new Promise(function (resolve, reject) {
      var filter = {};
      fitler[backColPropertyName] = {$elemMatch:{$eq:itemId}};
      _this.getList(backColCm.getName(), {
        filter: filter,
        nestingDepth: depth - 1
      }).then(function (results) {
        var edits, promises, newElements;
        promises = [];
        newElements = value.slice(0);
        for (var i = 0; i < results.length; i++) {
          var arrIndex = newElements.indexOf(results[i].getItemId());
          if (arrIndex < 0) {
            var backCol = results[i].getFromBase(backColPropertyName);
            if(backCol){
              bacCol.splice(backCol.indexOf(itemId));
              edits = {};
              edits[backColPropertyName] = bacCol;
              promises.push(_this._editItem(backColCm.getName(), results[i].getItemId(), edits));
            }
          } else {
            newElements.splice(arrIndex, 1);
          }
        }
        filter = {};
        fitler[backColCm.getKeyProperties()[0]] = {$in:newElements};
        _this.getList(backColCm.getName(), {
          filter: filter,
          nestingDepth: depth - 1
        }).then(function (newResults) {
          for (var i = 0; newResults.length; i++) {
            var backCol = newResults[i].getFromBase(backColPropertyName);
            if(!backCol){
              backCol = [];
            }
            backCol.push(itemId);
            edits = {};
            edits[backColPropertyName] = backCol;
            promises.push(_this._editItem(backColCm.getName(), newResults[i].getItemId(), edits));
          }
          Promise.all(promises).then(function (promiseResults) {
            resolve(value);
          }).catch(reject);
        }).catch(reject);
      }).catch(reject);
    });
  }

  function processCollection(cm, pm, collection, id) {
    return new Promise(function (resolve, reject) {
      var ccm = _this.meta.getMeta(pm.items_class);
      var filter;
      if (ccm) {
        if (pm.back_ref) {
          filter = {};
          fitler[pm.back_ref] = {$eq: id};
          _this.getList(pm.items_class, {
            filter: filter,
            nestingDepth: depth - 1
          }).then(function (results) {
            var edits, promises;
            promises = [];
            for (var i = 0; i < results.length; i++) {
              var arrIndex = collection.indexOf(results[i].getItemId());
              if (arrIndex < 0) {
                edits = {};
                edits[pm.back_ref] = null;
                promises.push(_this._editItem(pm.items_class, results[i].getItemId(), edits));
              } else {
                collection.splice(arrIndex, 1);
              }
            }
            for (var j = 0; collection.length; j++) {
              edits = {};
              edits[pm.back_ref] = id;
              promises.push(_this._editItem(pm.items_class, collection[j], edits));
            }
            Promise.all(promises).then(function (results) {
              resolve(pm.name, null);
            }).catch(reject);
          }).catch(reject);
        } else if (pm.back_coll) {
          processManyToManyCollection(id, collection, pm.back_coll, ccm)
            .then(function (value) {
              resolve(pm.name, value);
            }).catch(reject);
        } else {
          var ccmPropertyMetas = ccm.getPropertyMetas();
          var backColProperty = null;
          for (var i = 0; i < ccmPropertyMetas.length; i++) {
            if (ccmPropertyMetas[i].type === PropertyTypes.COLLECTION
              && ccmPropertyMetas[i].items_class == cm.name && ccmPropertyMetas[i].back_coll == pm.name) {
              backColProperty = ccmPropertyMetas[i];
            }
          }
          if (backColProperty) {
            processManyToManyCollection(id, collection, backColProperty.name, ccm)
              .then(function (value) {
                resolve(pm.name, value);
              }).catch(reject);
          } else {
            resolve(pm.name, collection);
          }
        }
      }
    });
  }

  /**
   * @param {ClassMeta} cm
   * @param {Object} data
   */
  function formUpdatedData(cm, data, id) {
    var updates, pm, nm, promises;
    updates = {};
    promises = [];
    for (nm in data) {
      if (data.hasOwnProperty(nm)) {
        pm = cm.getPropertyMeta(nm);
        if (pm) {
          if (pm.type === PropertyTypes.COLLECTION && pm.items_class) {
            promises.push(processCollection(cm, pm, data, id));
          } else {
            data[nm] = _this._castValue(data[nm], pm);
            updates[nm] = data[nm];
          }
        }
      }
    }
    return new Promise(function (resolve, reject) {
      Promise.all(promises).then(
        function (results) {
          console.log(results);
          resolve(updates);
        }).catch(reject);
    });
  }

  /**
   *
   * @param {String} classname
   * @param {Object} data
   * @param {String} [version]
   * @param {ChangeLogger} [changeLogger]
   * @param {Number} [nestingDepth]
   * @returns {Promise}
   */
  this._createItem = function (classname, data, version, changeLogger, nestingDepth) {
    return new Promise(function (resolve, reject) {
      try {
        var cm = _this.meta.getMeta(classname, version);
        var rcm = _this._getRootType(cm);

        var updates = formUpdatedData(cm, data, id);
        var properties = cm.getPropertyMetas();
        var pm;
        for (var i = 0;  i < properties.length; i++) {
          pm = properties[i];
          if (pm.autoassigned) {
            switch (pm.type) {
              case PropertyTypes.GUID: {
                updates[pm.name] = uuid.v1();
              }break;
              case PropertyTypes.DATETIME: {
                updates[pm.name] = new Date();
              }break;
              case PropertyTypes.INT: {
                updates[pm.name] = null;
                // TODO Implement autoincrement
              }break;
            }
          } else if (pm.default_value) {
            try {
              switch (pm.type) {
                case PropertyTypes.DATETIME: {
                  updates[pm.name] = new Date(pm.default_value);
                }break;
                case PropertyTypes.INT: {
                  updates[pm.name] = parseInt(pm.default_value);
                }break;
                case PropertyTypes.REAL:
                case PropertyTypes.DECIMAL: {
                  updates[pm.name] = parseFloat(pm.default_value);
                }break;
                default: {
                  updates[pm.name] = pm.default_value;
                }break;
              }
            } catch (err) {
            }
          }
        }
        updates._class = cm.getCanonicalName();
        updates._classVer = cm.getVersion();

        _this.ds.insert(tn(rcm), updates).then(function (data) {
          var item = _this._wrap(data._class, data, data._classVer);
          if (changeLogger) {
            return new Promise(function (resolve, reject) {
              changeLogger.LogChange(
                EventType.CREATE,
                item.getMetaClass().getCanonicalName(),
                item.getItemId(),
                updates
              ).then(function (record) {
                resolve([item]);
              }).catch(reject);
            });
          } else {
            return new Promise(function (resolve, reject) {
              resolve([item]);
            });
          }
        }).then(function (items) {
          return enrich(items, nestingDepth !== null ? nestingDepth : 1);
        }).then(function (items) {
            resolve(items[0]);
          }).catch(reject);
      } catch (err) {
        reject(err);
      }
    });
  };

  /**
   *
   * @param {String} classname
   * @param {String} id
   * @param {{}} data
   * @param {ChangeLogger} [changeLogger]
   * @param {Number} [nestingDepth]
   * @returns {Promise}
   */
  this._editItem = function (classname, id, data, changeLogger, nestingDepth) {
    return new Promise(function (resolve, reject) {
      try {
        var cm = _this.meta.getMeta(classname);
        var rcm = _this._getRootType(cm);

        var updates = formUpdatedData(cm, data);

        /**
         * @var {{}}
         */
        var conditions = _this.keyProvider.keyToData(rcm.getName(), id);

        if (conditions) {
          _this.ds.update(tn(rcm), conditions, updates).then(function (data) {
            var item = _this._wrap(data._class, data, data._classVer);
            if (changeLogger) {
              return new Promise(function (resolve, reject) {
                changeLogger.LogChange(
                  EventType.UPDATE,
                  item.getMetaClass().getCanonicalName(),
                  item.getItemId(),
                  updates
                ).then(function (record) {
                  resolve([item]);
                }).catch(reject);
              });
            } else {
              return new Promise(function (resolve, reject) {
                resolve([item]);
              });
            }
          }).then(function (items) {
            return enrich(items, nestingDepth !== null ? nestingDepth : 1);
          }).then(function (items) {
            resolve(items[0]);
          }).catch(reject);
        } else {
          reject({Error: 'Не указан идентификатор объекта!'});
        }
      } catch (err) {
        reject(err);
      }
    });
  };

  /**
   *
   * @param {String} classname
   * @param {String} id
   * @param {{}} data
   * @param {String} [version]
   * @param {ChangeLogger} [changeLogger]
   * @param {Number} [nestingDepth]
   * @returns {Promise}
   */
  this._saveItem = function (classname, id, data, version, changeLogger, nestingDepth) {
    return new Promise(function (resolve, reject) {
      try {
        var cm = _this.meta.getMeta(classname, version);
        var rcm = _this._getRootType(cm);

        var updates = formUpdatedData(cm, data);
        var conditions;
        if (id) {
          conditions = _this.keyProvider.keyToData(rcm.getName(), id, rcm.getNamespace());
        } else {
          conditions = _this.keyProvider.keyData(rcm.getName(), updates, rcm.getNamespace());
        }

        updates._class = cm.getName();
        updates._classVer = cm.getVersion();

        _this.ds.upsert(tn(rcm), conditions, updates).then(function (data) {
          var item = _this._wrap(data._class, data, data._classVer);
          if (changeLogger) {
            return new Promise(function (resolve, reject) {
              changeLogger.LogChange(
                EventType.UPDATE, // TODO Определять факт создания объекта
                item.getMetaClass().getCanonicalName(),
                item.getItemId(),
                updates
              ).then(function (record) {
                resolve([item]);
              }).catch(reject);
            });
          } else {
            return new Promise(function (resolve, reject) {
              resolve([item]);
            });
          }
        }).then(function (items) {
          return enrich(items, nestingDepth !== null ? nestingDepth : 1);
        }).then(function (items) {
          resolve(items[0]);
        }).catch(reject);
      } catch (err) {
        reject(err);
      }
    });
  };

  /**
   *
   * @param {String} classname
   * @param {String} id
   * @param {ChangeLogger} [changeLogger]
   */
  this._deleteItem = function (classname, id, changeLogger) {
    var cm = _this.meta.getMeta(classname);
    var rcm = _this._getRootType(cm);

    return new Promise(function (resolve, reject) {
      _this.ds.delete(tn(rcm), _this.keyProvider.keyToData(rcm.getName(), id, rcm.getNamespace())).then(function () {
        if (changeLogger) {
          changeLogger.LogChange(
            EventType.DELETE,
            cm.getCanonicalName(),
            id,
            {}).
            then(resolve).
            catch(reject);
        } else {
          resolve();
        }
      }).catch(reject);
    });
  };

  /**
   *
   * @param {Item} master
   * @param {String} collection
   * @param {Item} detail
   * @param {ChangeLogger} [changeLogger]
   * @returns {Promise}
   */
  this._put = function (master, collection, detail, changeLogger) {
    var mrcm = this._getRootType(master.classMeta);
    var colProp = master.ClassMeta.getPropertyMeta(collection);
    if (colProp.back_ref) {
      var update = {};
      update[colProp.back_ref] = master.getItemId();
      return this.EditItem(detail.classMeta.getCanonicalName(), detail.getItemId(), update, changeLogger);
    }
    return new Promise(function (resolve, reject) {
        _this.ds.get(tn(mrcm), master.getItemId()).then(
          function (mdata) {
            if (!mdata[collection]) {
              mdata[collection] = [];
            }
            mdata[collection][mdata[collection].length] = detail.getItemId();
            _this.ds.update(
              tn(mrcm),
              _this.keyProvider.keyToData(mrcm.getName(), master.getItemId(), mrcm.getNamespace()),
              mdata).
            then(
              function (mdata) {
                if (changeLogger) {
                  var updates = {};
                  updates[collection] = {
                    className: detail.metaClass.getCanonicalName(),
                    id: detail.getItemId()
                  };
                  changeLogger.LogChange(
                    EventType.PUT,
                    master.classMeta.getCanonicalName(),
                    master.getItemId(),
                    updates);
                } else {
                  resolve();
                }
              }
            ).catch(reject);
          }
        ).catch(reject);
      }
    );
  };

  /**
   *
   * @param {Item} master
   * @param {String} collection
   * @param {Item} detail
   * @param {ChangeLogger} [changeLogger]
   * @returns {Promise}
   */
  this._eject = function (master, collection, detail, changeLogger) {
    var mrcm = this._getRootType(master.classMeta);
    var colProp = master.ClassMeta.getPropertyMeta(collection);
    if (colProp.back_ref) {
      var update = {};
      update[colProp.back_ref] = null;
      return this.EditItem(detail.classMeta.getCanonicalName(), detail.getItemId(), update, changeLogger);
    }
    return new Promise(function (resolve, reject) {
        _this.ds.get(tn(mrcm), master.getItemId()).then(
          function (mdata) {
            if (mdata[collection]) {
              mdata[collection].splice(mdata[collection].indexOf(detail.getItemId()), 1);
              _this.ds.update(tn(mrcm),
                _this.keyProvider.keyToData(mrcm.getName(), master.getItemId(), mrcm.getNamespace()),
                mdata).
                then(
                function (mdata) {
                  if (changeLogger) {
                    var updates = {};
                    updates[collection] = {
                      className: detail.metaClass.getCanonicalName(),
                      id: detail.getItemId()
                    };
                    changeLogger.LogChange(
                      EventType.EJECT,
                      master.classMeta.getCanonicalName(),
                      master.getItemId(),
                      updates);
                  } else {
                    resolve();
                  }
                }
              ).catch(reject);
            } else {
              resolve();
            }
          }
        ).catch(reject);
      }
    );
  };

  /**
   *
   * @param {Item} master
   * @param {String} collection
   * @param {Object} [options]
   * @param {Object} [options.filter]
   * @param {Number} [options.offset]
   * @param {Number} [options.count]
   * @param {Object} [options.sort]
   * @param {Boolean} [options.countTotal]
   * @param {Number} [options.nestingDepth]
   * @returns {Promise}
   */
  this._getAssociationsList = function (master, collection, options) {
    var mrcm = this._getRootType(master.classMeta);
    var drcm = this._getRootType(
      this.meta.getMeta(master.classMeta.getPropertyMeta(collection).items_class, null, master.classMeta.getNamespace())
    );
    return new Promise(function (resolve, reject) {
      _this.ds.get(tn(mrcm), _this.keyProvider.keyToData(mrcm.getName(), master.getItemId(), mrcm.getNamespace())).
        then(function (mdata) {
          if (mdata[collection]) {
            var idf = {_id: {$in: mdata[collection]}};
            if (!options) {
              options = {};
            }
            options.filter = options.filter ? {$and: [options.filter,idf]} : idf;
            _this.ds.fetch(tn(drcm), options).
              then(function (data) {
                var result = [];
                for (var i = 0; i < data.length; i++) {
                  result[i] = _this._wrap(data[i]._class, data[i], data[i]._classVer);
                }
                return enrich(result, options.nestingDepth ? options.nestingDepth : 1);
              }).then(resolve).
              catch(reject);
          } else {
            resolve([]);
          }
        }).
        catch(reject);
    });
  };

  /**
   *
   * @param {Item} master
   * @param {String} collection
   * @param {{filter: Object}} [options]
   * @returns {Promise}
   */
  this._getAssociationsCount = function (master, collection, options) {
    var mrcm = this._getRootType(master.classMeta);
    var drcm = this._getRootType(
      this.meta.getMeta(master.classMeta.getPropertyMeta(collection).items_class, master.classMeta.getNamespace())
    );
    return new Promise(function (resolve, reject) {
      _this.ds.get(tn(mrcm), _this.keyProvider.keyToData(mrcm.getName(), master.getItemId(), mrcm.getNamespace())).
        then(function (mdata) {
          if (mdata[collection]) {
            var idf = {_id: {$in: mdata[collection]}};
            if (!options) {
              options = {};
            }
            options.filter = options.filter ? {$and: [options.filter,idf]} : idf;
            _this.ds.count(tn(drcm), options).
              then(resolve).
              catch(reject);
          } else {
            resolve(0);
          }
        }).
        catch(reject);
    });
  };
}

IonDataRepository.prototype = new DataRepository();
module.exports = IonDataRepository;
