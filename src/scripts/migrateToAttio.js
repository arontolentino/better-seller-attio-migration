#!/usr/bin/env node
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const dotenv = require('dotenv');

// Load environment variables
dotenv.config();

// Configuration for different objects
const objectConfigs = {
  members: {
    objectId: 'c3a9bb82-ec1a-431e-99fe-459da161d794',
    jsonFilePath: path.join(__dirname, '../objects/members/attributes.json'),
    tableName: 'users',
    primaryKey: 'userId',
    batchSize: 50,
  },
  leads: {
    objectId: 'ab6d4a3b-621f-40b1-9cc2-1c96cd480af7',
    jsonFilePath: path.join(__dirname, '../objects/leads/attributes.json'),
    tableName: 'leads',
    primaryKey: 'leadId',
    batchSize: 50,
  },
  deals: {
    objectId: 'a93a7eff-aa5d-4526-90a7-0eae8e387eb6',
    jsonFilePath: path.join(__dirname, '../objects/deals/attributes.json'),
    tableName: 'salesClients',
    primaryKey: 'salesClientId',
    batchSize: 50,
  },
  companies: {
    objectId: '26f4002b-22f9-4631-9775-45599bfc58c4',
    jsonFilePath: path.join(__dirname, '../objects/companies/attributes.json'),
    tableName: 'agencyClients',
    primaryKey: 'agencyClientId',
    batchSize: 50,
  },
};

/**
 * Ensures the required tracking columns exist in the database table
 * @param {Object} client PostgreSQL client
 * @param {string} tableName Table name to check/modify
 * @returns {Promise<void>}
 */
async function ensureTrackingColumns(client, tableName) {
  try {
    // Check if columns exist
    const columnCheckQuery = `
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = $1 
      AND column_name IN ('attio_external_id', 'attio_last_synced_at', 'attio_sync_status');
    `;
    const { rows } = await client.query(columnCheckQuery, [tableName]);

    const existingColumns = rows.map((row) => row.column_name);
    const columnsToAdd = [];

    if (!existingColumns.includes('attio_external_id')) {
      columnsToAdd.push('attio_external_id VARCHAR(255)');
    }

    if (!existingColumns.includes('attio_last_synced_at')) {
      columnsToAdd.push('attio_last_synced_at TIMESTAMP WITH TIME ZONE');
    }

    if (!existingColumns.includes('attio_sync_status')) {
      columnsToAdd.push('attio_sync_status VARCHAR(50)');
    }

    if (columnsToAdd.length > 0) {
      const alterQuery = `ALTER TABLE ${tableName} ADD COLUMN ${columnsToAdd.join(
        ', ADD COLUMN '
      )}`;
      await client.query(alterQuery);
      console.log(`Added tracking columns to ${tableName}`);
    }
  } catch (error) {
    console.error('Error ensuring tracking columns:', error);
    throw error;
  }
}

/**
 * Starts a new sync run and records it in the metadata table
 * @param {Object} client PostgreSQL client
 * @param {string} objectName Name of the object being synced
 * @returns {Promise<number>} ID of the created sync run record
 */
async function startSyncRun(client, objectName) {
  const query = `
    INSERT INTO attio_sync_metadata (object_name, started_at, status)
    VALUES ($1, NOW(), 'in_progress')
    RETURNING id;
  `;
  const result = await client.query(query, [objectName]);
  const syncId = result.rows[0].id;
  console.log(`Started sync run #${syncId} for ${objectName}`);
  return syncId;
}

/**
 * Updates the sync status of a record
 * @param {Object} client PostgreSQL client
 * @param {string} tableName Table name
 * @param {string} primaryKey Primary key column name
 * @param {string|number} primaryKeyValue Primary key value
 * @param {string} status Sync status ('synced', 'failed', etc.)
 * @param {string} [attioExternalId] Attio external ID (for successful syncs)
 * @returns {Promise<void>}
 */
async function updateSyncStatus(
  client,
  tableName,
  primaryKey,
  primaryKeyValue,
  status,
  attioExternalId = null
) {
  const query = `
    UPDATE ${tableName}
    SET 
      attio_sync_status = $1,
      attio_last_synced_at = NOW()
      ${attioExternalId ? ', attio_external_id = $3' : ''}
    WHERE ${primaryKey} = $2;
  `;

  const params = attioExternalId
    ? [status, primaryKeyValue, attioExternalId]
    : [status, primaryKeyValue];

  await client.query(query, params);
}

/**
 * Completes a sync run and updates its metadata
 * @param {Object} client PostgreSQL client
 * @param {number} syncId ID of the sync run
 * @param {Object} stats Sync statistics
 * @param {number} stats.processed Total records processed
 * @param {number} stats.created Records created
 * @param {number} stats.updated Records updated
 * @param {number} stats.failed Records failed
 * @param {string} [error] Error details if sync failed
 * @returns {Promise<void>}
 */
async function completeSyncRun(client, syncId, stats, error = null) {
  const status = error ? 'failed' : 'completed';

  const query = `
    UPDATE attio_sync_metadata
    SET 
      completed_at = NOW(),
      records_processed = $1,
      records_created = $2,
      records_updated = $3,
      records_failed = $4,
      status = $5,
      error_details = $6
    WHERE id = $7;
  `;

  await client.query(query, [
    stats.processed,
    stats.created,
    stats.updated,
    stats.failed,
    status,
    error,
    syncId,
  ]);

  console.log(`Completed sync run #${syncId} with status: ${status}`);
}

/**
 * Creates an API client for interacting with Attio
 */
function createAttioApiClient(objectId, token, attioBaseUrl, dryRun = false) {
  return {
    async makeRequest(fn, retries = 3, delay = 1000) {
      let lastError;
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          return await fn();
        } catch (error) {
          lastError = error;
          if (error.response?.status === 429) {
            // Rate limiting - wait longer
            const waitTime = delay * Math.pow(2, attempt);
            console.log(
              `Rate limited. Retrying in ${waitTime}ms (attempt ${attempt}/${retries})...`
            );
            await new Promise((resolve) => setTimeout(resolve, waitTime));
          } else if (attempt < retries) {
            console.log(
              `Request failed. Retrying in ${delay}ms (attempt ${attempt}/${retries})...`
            );
            await new Promise((resolve) => setTimeout(resolve, delay));
          } else {
            throw error;
          }
        }
      }
      throw lastError;
    },

    async createRecord(values) {
      if (dryRun) {
        console.log(
          'DRY RUN - Would create record:',
          JSON.stringify(values, null, 2)
        );
        return {
          success: true,
          dryRun: true,
          data: { id: { record_id: 'dry-run-id' } },
        };
      }

      try {
        return await this.makeRequest(async () => {
          const payload = { data: { values } };
          const response = await axios.post(
            `${attioBaseUrl}/objects/${objectId}/records`,
            payload,
            {
              headers: {
                accept: 'application/json',
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
              },
            }
          );
          return { success: true, data: response.data.data };
        });
      } catch (error) {
        console.error(
          'Error creating record:',
          error.response ? error.response.data : error.message
        );
        return { success: false, error };
      }
    },

    async updateRecord(recordId, values) {
      if (dryRun) {
        console.log(
          `DRY RUN - Would update record ${recordId}:`,
          JSON.stringify(values, null, 2)
        );
        return {
          success: true,
          dryRun: true,
          data: { id: { record_id: recordId } },
        };
      }

      try {
        return await this.makeRequest(async () => {
          const payload = { data: { values } };
          const response = await axios.put(
            `${attioBaseUrl}/objects/${objectId}/records/${recordId}`,
            payload,
            {
              headers: {
                accept: 'application/json',
                'content-type': 'application/json',
                authorization: `Bearer ${token}`,
              },
            }
          );
          return { success: true, data: response.data.data };
        });
      } catch (error) {
        console.error(
          `Error updating record ${recordId}:`,
          error.response ? error.response.data : error.message
        );
        return { success: false, error };
      }
    },

    async findRecordByIdentifier(identifierAttributeId, identifierValue) {
      try {
        return await this.makeRequest(async () => {
          const filter = {
            operator: 'equals',
            attribute_id: identifierAttributeId,
            value: identifierValue,
          };

          const response = await axios.get(
            `${attioBaseUrl}/objects/${objectId}/records?filter=${encodeURIComponent(
              JSON.stringify(filter)
            )}`,
            {
              headers: {
                accept: 'application/json',
                authorization: `Bearer ${token}`,
              },
            }
          );

          const records = response.data.data;
          return records.length > 0 ? records[0] : null;
        });
      } catch (error) {
        console.error(
          `Error finding record with ${identifierAttributeId}=${identifierValue}:`,
          error.response ? error.response.data : error.message
        );
        return null;
      }
    },
  };
}

/**
 * Creates a query builder for constructing SQL queries
 */
function createQueryBuilder(fullSync, retryFailed, since) {
  return {
    whereConditions: [],
    params: [],
    paramIndex: 1,

    buildWhereClause() {
      if (!fullSync) {
        if (retryFailed) {
          this.whereConditions.push(`attio_sync_status = 'failed'`);
        } else {
          this.whereConditions.push(`(
            attio_last_synced_at IS NULL OR 
            updatedAt > attio_last_synced_at OR 
            attio_sync_status = 'failed'
          )`);
        }
      }

      if (since) {
        this.whereConditions.push(`updatedAt >= $${this.paramIndex}`);
        this.params.push(new Date(since));
        this.paramIndex++;
      }

      return this.whereConditions.length > 0
        ? `WHERE ${this.whereConditions.join(' AND ')}`
        : '';
    },
  };
}

/**
 * Processes a database record and syncs it to Attio
 */
async function processRecord(
  record,
  client,
  api,
  dbToAttioMapping,
  dbToAttioTypeMapping,
  identifierAttributeId,
  tableName,
  primaryKey,
  stats
) {
  // Convert PostgreSQL record to Attio values format
  const attioValues = {};

  for (const [dbColumn, value] of Object.entries(record)) {
    if (dbToAttioMapping[dbColumn] && value !== null) {
      const attioType = dbToAttioTypeMapping[dbColumn];
      const attioAttributeId = dbToAttioMapping[dbColumn];

      // Handle different data types
      if (attioType === 'timestamp' && value instanceof Date) {
        attioValues[attioAttributeId] = value.toISOString();
      } else if (attioType === 'checkbox' && typeof value === 'boolean') {
        attioValues[attioAttributeId] = value;
      } else if (
        attioType === 'number' &&
        (typeof value === 'number' || !isNaN(Number(value)))
      ) {
        attioValues[attioAttributeId] = Number(value);
      } else {
        attioValues[attioAttributeId] = String(value);
      }
    }
  }

  const recordId = record[primaryKey];

  // If we already have an Attio external ID, update directly
  if (record.attio_external_id) {
    return await updateExistingRecord(
      record.attio_external_id,
      recordId,
      attioValues,
      api,
      client,
      tableName,
      primaryKey,
      stats
    );
  }

  // Otherwise, check if record exists in Attio by identifier
  const existingRecord = await api.findRecordByIdentifier(
    identifierAttributeId,
    String(recordId)
  );

  if (existingRecord) {
    return await updateExistingRecord(
      existingRecord.id.record_id,
      recordId,
      attioValues,
      api,
      client,
      tableName,
      primaryKey,
      stats
    );
  } else {
    return await createNewRecord(
      recordId,
      attioValues,
      api,
      client,
      tableName,
      primaryKey,
      stats
    );
  }
}

/**
 * Updates an existing record in Attio
 */
async function updateExistingRecord(
  attioRecordId,
  dbRecordId,
  attioValues,
  api,
  client,
  tableName,
  primaryKey,
  stats
) {
  console.log(`Updating record with ${primaryKey}=${dbRecordId}`);
  const result = await api.updateRecord(attioRecordId, attioValues);

  if (result.success) {
    await updateSyncStatus(
      client,
      tableName,
      primaryKey,
      dbRecordId,
      'synced',
      attioRecordId
    );
    stats.updated++;
    console.log(`Successfully updated record with ${primaryKey}=${dbRecordId}`);
  } else {
    await updateSyncStatus(client, tableName, primaryKey, dbRecordId, 'failed');
    stats.failed++;
    console.error(`Failed to update record with ${primaryKey}=${dbRecordId}`);
  }
}

/**
 * Creates a new record in Attio
 */
async function createNewRecord(
  dbRecordId,
  attioValues,
  api,
  client,
  tableName,
  primaryKey,
  stats
) {
  console.log(`Creating new record with ${primaryKey}=${dbRecordId}`);
  const result = await api.createRecord(attioValues);

  if (result.success) {
    const attioRecordId = result.data.id.record_id;
    await updateSyncStatus(
      client,
      tableName,
      primaryKey,
      dbRecordId,
      'synced',
      attioRecordId
    );
    stats.created++;
    console.log(`Successfully created record with ${primaryKey}=${dbRecordId}`);
  } else {
    await updateSyncStatus(client, tableName, primaryKey, dbRecordId, 'failed');
    stats.failed++;
    console.error(`Failed to create record with ${primaryKey}=${dbRecordId}`);
  }
}

/**
 * Migrates data from PostgreSQL to Attio
 */
async function migrateToAttio(options) {
  const {
    objectId,
    jsonFilePath,
    tableName,
    primaryKey,
    batchSize = 50,
    attioBaseUrl = process.env.ATTIO_BASE_URL || 'https://api.attio.com/v2',
    token = process.env.ATTIO_API_TOKEN,
    pgConfig = {
      host: process.env.POSTGRES_HOST || 'localhost',
      port: process.env.POSTGRES_PORT || 5432,
      database: process.env.POSTGRES_DB,
      user: process.env.POSTGRES_USER,
      password: process.env.POSTGRES_PASSWORD,
    },
    dryRun = false,
    fullSync = false,
    retryFailed = false,
    since = null,
  } = options;

  // Validate required parameters
  if (!token) {
    throw new Error(
      'Attio API token is required. Set ATTIO_API_TOKEN environment variable or provide in options.'
    );
  }

  if (!pgConfig.database || !pgConfig.user) {
    throw new Error(
      'PostgreSQL configuration is incomplete. Set environment variables or provide in options.'
    );
  }

  // Initialize counters
  const stats = { processed: 0, created: 0, updated: 0, failed: 0 };

  // Create API client
  const api = createAttioApiClient(objectId, token, attioBaseUrl, dryRun);

  // Load attribute mapping
  let attributeMapping;
  try {
    const fileContent = fs.readFileSync(jsonFilePath, 'utf8');
    attributeMapping = JSON.parse(fileContent);
  } catch (err) {
    console.error('Error reading attribute mapping file:', err);
    throw err;
  }

  // Create mappings from database columns to Attio attributes
  const dbToAttioMapping = {};
  const dbToAttioTypeMapping = {};
  let identifierAttributeId = null;

  for (const [key, mapping] of Object.entries(attributeMapping)) {
    if (mapping.database && mapping.attio?.attribute_id) {
      dbToAttioMapping[mapping.database.columnName] =
        mapping.attio.attribute_id;
      dbToAttioTypeMapping[mapping.database.columnName] = mapping.attio.type;

      // Use the primary key as the identifier for finding records
      if (mapping.database.columnName === primaryKey) {
        identifierAttributeId = mapping.attio.attribute_id;
      }
    }
  }

  if (!identifierAttributeId) {
    throw new Error(
      `Primary key ${primaryKey} not found in attribute mapping or missing attribute_id`
    );
  }

  // Connect to PostgreSQL
  const pool = new Pool(pgConfig);
  let client;
  let syncId;

  try {
    client = await pool.connect();
    console.log(`Connected to PostgreSQL database: ${pgConfig.database}`);

    // Ensure tracking columns exist
    await ensureTrackingColumns(client, tableName);

    // Start sync run
    syncId = await startSyncRun(client, tableName);

    // Build the query based on sync options
    const queryBuilder = createQueryBuilder(fullSync, retryFailed, since);
    const whereClause = queryBuilder.buildWhereClause();

    // Get total count of records to process
    const countQuery = `SELECT COUNT(*) FROM ${tableName} ${whereClause}`;
    const countResult = await client.query(countQuery, queryBuilder.params);
    const totalRecords = parseInt(countResult.rows[0].count, 10);
    console.log(
      `Found ${totalRecords} records to process in ${tableName} table`
    );

    // Process records in batches
    for (let offset = 0; offset < totalRecords; offset += batchSize) {
      console.log(
        `Processing batch: ${offset + 1} to ${Math.min(
          offset + batchSize,
          totalRecords
        )}`
      );

      // Fetch a batch of records
      const batchQueryParams = [...queryBuilder.params, batchSize, offset];
      const query = `
        SELECT * FROM ${tableName} 
        ${whereClause} 
        ORDER BY updatedAt 
        LIMIT $${queryBuilder.paramIndex} OFFSET $${queryBuilder.paramIndex + 1}
      `;

      const result = await client.query(query, batchQueryParams);

      // Process each record in the batch
      for (const record of result.rows) {
        stats.processed++;
        await processRecord(
          record,
          client,
          api,
          dbToAttioMapping,
          dbToAttioTypeMapping,
          identifierAttributeId,
          tableName,
          primaryKey,
          stats
        );
      }
    }

    // Complete sync run
    await completeSyncRun(client, syncId, stats);

    console.log(
      `Migration completed: ${stats.processed} processed, ${stats.created} created, ${stats.updated} updated, ${stats.failed} failed`
    );
    return stats;
  } catch (err) {
    console.error('Error during migration:', err);

    // Record sync failure if we have a sync ID
    if (client && syncId) {
      await completeSyncRun(
        client,
        syncId,
        stats,
        err.message || 'Unknown error'
      );
    }

    throw err;
  } finally {
    if (client) client.release();
    await pool.end();
  }
}

// If this script is run directly, use command line arguments
if (require.main === module) {
  // Parse command line arguments
  const args = process.argv.slice(2);
  let objectName = null;
  let dryRun = false;
  let batchSize = null;
  let fullSync = false;
  let retryFailed = false;
  let since = null;

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--object' && i + 1 < args.length) {
      objectName = args[i + 1];
      i++;
    } else if (args[i] === '--dry-run') {
      dryRun = true;
    } else if (args[i] === '--batch-size' && i + 1 < args.length) {
      batchSize = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--full-sync') {
      fullSync = true;
    } else if (args[i] === '--retry-failed') {
      retryFailed = true;
    } else if (args[i] === '--since' && i + 1 < args.length) {
      since = args[i + 1];
      i++;
    }
  }

  // Validate arguments
  if (!objectName || !objectConfigs[objectName]) {
    console.error(`
Error: Invalid or missing object name.
Usage: 
  node migrateToAttio.js --object <objectName> [--dry-run] [--batch-size <number>] [--full-sync] [--retry-failed] [--since <date>]

Available objects: ${Object.keys(objectConfigs).join(', ')}
    `);
    process.exit(1);
  }

  // Configure migration options
  const migrationConfig = {
    ...objectConfigs[objectName],
    dryRun,
    fullSync,
    retryFailed,
    since,
  };

  if (batchSize) {
    migrationConfig.batchSize = batchSize;
  }

  // Run the migration
  migrateToAttio(migrationConfig)
    .then((result) => {
      console.log(`
      Migration summary:
        Processed: ${result.processed}
        Created: ${result.created}
        Updated: ${result.updated}
        Failed: ${result.failed}
      `);
      process.exit(0);
    })
    .catch((error) => {
      console.error('Unhandled error in main process:', error);
      process.exit(1);
    });
}

// Export the migration function for use in other scripts
module.exports = { migrateToAttio };
