'use strict'

var config = require('spacetime-config')
var R = require('ramda')
var pg = require('pg')
var QueryStream = require('pg-query-stream')

const tableName = 'pits'

// https://devcenter.heroku.com/articles/getting-started-with-nodejs#provision-a-database
var pgConString = process.env.DATABASE_URL || `postgres://${config.postgres.user}:${config.postgres.password}@${config.postgres.host}:${config.postgres.port}/${config.postgres.database}`
function executeQuery (query, values, callback) {
  pg.connect(pgConString, function (err, client, done) {
    if (err) {
      callback(err)
    } else {
      client.query(query, values, function (err, result) {
        done()
        if (err) {
          callback(err)
        } else {
          callback(null, result.rows)
        }
      })
    }
  })
}

module.exports.executeQuery = executeQuery

var truncateTable = `
  TRUNCATE ${tableName};
`

var tableExists = `
  SELECT COUNT(*)
  FROM pg_catalog.pg_tables
  WHERE schemaname = 'public'
  AND tablename  = '${tableName}';
`

var createTable = `
  CREATE TABLE public.${tableName} (
    id text NOT NULL,
    dataset text NOT NULL,
    name text,
    type text,
    validSince daterange,
    validUntil daterange,
    data jsonb,
    geometry geometry,
    CONSTRAINT ${tableName}_pkey PRIMARY KEY (id, dataset)
  );
  CREATE INDEX ${tableName}_gix ON ${tableName} USING GIST (geometry);
  CREATE INDEX ${tableName}_dataset ON ${tableName} (dataset);
  CREATE INDEX ${tableName}_type ON ${tableName} (type);
  CREATE INDEX ${tableName}_id ON ${tableName} (id);
`

module.exports.initialize = function () {
  executeQuery(tableExists, null, function (err, rows) {
    if (err) {
      console.error('Error connecting to database:', err.message)
      process.exit(-1)
    } else {
      if (!(rows && rows[0].count === '1')) {
        console.log(`Table "${tableName}" does not exist - creating table...`)
        executeQuery(createTable, null, function (err) {
          if (err) {
            console.error('Error creating table:', err.message)
            process.exit(-1)
          }
        })
      }
    }
  })
}

module.exports.truncate = function (callback) {
  executeQuery(truncateTable, null, (err) => {
    if (err) {
      callback(err)
    } else {
      callback()
    }
  })
}

function escapeLiteral (str) {
  if (!str) {
    return 'NULL'
  }

  var hasBackslash = false
  var escaped = '\''

  for (var i = 0; i < str.length; i++) {
    var c = str[i]
    if (c === '\'') {
      escaped += c + c
    } else if (c === '\\') {
      escaped += c + c
      hasBackslash = true
    } else {
      escaped += c
    }
  }

  escaped += '\''

  if (hasBackslash === true) {
    escaped = ' E' + escaped
  }

  return escaped
}

function rangeString (dateRange) {
  if (dateRange) {
    return `[${dateRange[0]}, ${dateRange[1]}]`
  }

  return null
}

function toRow (pit, dataset) {
  return {
    id: escapeLiteral(pit.id),
    dataset: `'${dataset}'`,
    name: escapeLiteral(pit.name),
    type: `'${pit.type}'`,
    data: escapeLiteral(JSON.stringify(pit.data)),
    validSince: escapeLiteral(rangeString(pit.validSince)),
    validUntil: escapeLiteral(rangeString(pit.validUntil)),
    geometry: pit.geometry ? `ST_SetSRID(ST_GeomFromGeoJSON('${JSON.stringify(pit.geometry)}'), 4326)` : 'NULL'
  }
}

function createUpdateQuery (message) {
  var row = toRow(message.payload, message.meta.dataset)

  var columns = R.keys(row)
  var values = R.values(row)

  var query = `INSERT INTO ${tableName} (${columns.join(', ')})
    VALUES (${values.join(', ')})
    ON CONFLICT (id, dataset)
    DO UPDATE SET
      name = EXCLUDED.name,
      type = EXCLUDED.type,
      data = EXCLUDED.data,
      validSince = EXCLUDED.validSince,
      validUntil = EXCLUDED.validUntil,
      geometry = EXCLUDED.geometry;
  `

  return query
}

function deleteQuery (message) {
  var id = escapeLiteral(message.payload.id)
  var dataset = escapeLiteral(message.meta.dataset)

  var query = `DELETE FROM ${tableName}
    WHERE
      id = ${id} AND
      dataset = ${dataset};`

  return query
}

var actionToQuery = {
  create: createUpdateQuery,
  update: createUpdateQuery,
  delete: deleteQuery
}

function messageToQuery (message) {
  return actionToQuery[message.action](message)
}

module.exports.createQueryStream = function (query, callback) {
  pg.connect(pgConString, function (err, client, done) {
    if (err) {
      callback(err)
    } else {
      var queryStream = new QueryStream(query)
      var stream = client.query(queryStream)
      stream.on('end', done)
      callback(null, stream, queryStream)
    }
  })
}

module.exports.bulk = function (messages, callback) {
  var queries = messages
    .filter((i) => i.type === 'pit')
    .map(messageToQuery)

  if (queries.length) {
    executeQuery(queries.join('\n'), null, function (err) {
      if (err) {
        callback(err)
      } else {
        console.log('PostGIS =>', messages.length)
        callback()
      }
    })
  } else {
    callback()
  }
}
