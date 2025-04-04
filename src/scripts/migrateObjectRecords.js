#!/usr/bin/env node
const axios = require('axios');
const fs = require('fs');
const path = require('path');
const { Pool } = require('pg');
const dotenv = require('dotenv');
const winston = require('winston');
// We'll use dynamic import for p-limit

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
 * Creates a simple logger with verbose mode control
 */
function createLogger(options = {}) {
  const { verbose = false } = options;

  return {
    log: (...args) => {
      // Only log if in verbose mode
      if (verbose) {
        console.log(...args);
      }
    },

    warn: (...args) => {
      // Only log warnings if in verbose mode
      if (verbose) {
        console.warn(...args);
      }
    },

    error: (...args) => {
      // Always log errors
      console.error(...args);
    },

    // For important messages that should always be shown
    important: (...args) => {
      console.log(...args);
    },

    // For progress updates
    progress: (...args) => {
      if (verbose) {
        console.log(...args);
      }
    },

    // No-op close method for API compatibility
    close: async () => {
      return Promise.resolve(null);
    },

    getLogFilePath: () => null,
  };
}

/**
 * Ensures tracking columns exist in the database table
 */
async function ensureTrackingColumns(client, tableName) {
  try {
    const { rows } = await client.query(
      `
      SELECT column_name 
      FROM information_schema.columns 
      WHERE table_name = $1 
      AND column_name IN ('attioExternalId', 'attioLastSyncedAt', 'attioSyncStatus');
    `,
      [tableName]
    );

    const existingColumns = rows.map((row) => row.column_name);
    const columnsToAdd = [];

    if (!existingColumns.includes('attioExternalId'))
      columnsToAdd.push('"attioExternalId" VARCHAR(255)');
    if (!existingColumns.includes('attioLastSyncedAt'))
      columnsToAdd.push('"attioLastSyncedAt" TIMESTAMP WITH TIME ZONE');
    if (!existingColumns.includes('attioSyncStatus'))
      columnsToAdd.push('"attioSyncStatus" VARCHAR(50)');

    if (columnsToAdd.length > 0) {
      await client.query(
        `ALTER TABLE "${tableName}" ADD COLUMN ${columnsToAdd.join(
          ', ADD COLUMN '
        )}`
      );
      console.log(`Added tracking columns to ${tableName}`);
    }
  } catch (error) {
    console.error('Error ensuring tracking columns:', error);
    throw error;
  }
}

/**
 * Converts a database value to the appropriate format for Attio based on the attribute type
 */
function convertValueForAttio(value, attioType) {
  if (value === null || value === undefined) {
    return null;
  }

  switch (attioType) {
    case 'timestamp':
      return new Date(value).toISOString();
    case 'date':
      // Return just the date portion for date fields
      return new Date(value).toISOString().split('T')[0];
    case 'number':
      return Number(value);
    case 'checkbox':
      return Boolean(value);
    case 'record-reference':
      // This will be handled separately by the relationship processing
      return value;
    case 'multi-select':
      // Handle array values for multi-select fields
      if (Array.isArray(value)) {
        return value;
      } else if (
        typeof value === 'string' &&
        value.startsWith('[') &&
        value.endsWith(']')
      ) {
        // Handle JSON array strings
        try {
          return JSON.parse(value);
        } catch (e) {
          console.warn(`Failed to parse multi-select value: ${value}`);
          return [value];
        }
      } else {
        // Single value, wrap in array
        return [value];
      }
    default:
      // For text and other types, convert to string
      return String(value);
  }
}

/**
 * Creates an API client for interacting with Attio
 */
function createAttioApiClient(
  objectId,
  token,
  attioBaseUrl,
  dryRun = false,
  attioIdToTitle,
  logger
) {
  return {
    async makeRequest(fn, retries = 5, initialDelay = 1000) {
      for (let attempt = 1; attempt <= retries; attempt++) {
        try {
          return await fn();
        } catch (error) {
          if (error.response?.status === 429) {
            // Parse the Retry-After header if available
            let waitTime;
            const retryAfter = error.response.headers['retry-after'];

            if (retryAfter) {
              // Check if Retry-After is a date string or seconds
              if (isNaN(retryAfter)) {
                // It's a date string
                const retryDate = new Date(retryAfter);
                waitTime = Math.max(100, retryDate.getTime() - Date.now());
              } else {
                // It's seconds
                waitTime = parseInt(retryAfter, 10) * 1000;
              }
            } else {
              // Fallback to exponential backoff if no Retry-After header
              waitTime = initialDelay * Math.pow(2, attempt - 1);
            }

            logger.log(
              `Rate limited. Retrying in ${waitTime}ms (attempt ${attempt}/${retries})...`
            );

            // Add jitter to prevent thundering herd problem
            const jitter = Math.random() * 200;
            await new Promise((resolve) =>
              setTimeout(resolve, waitTime + jitter)
            );
          } else if (attempt < retries) {
            // For non-rate limit errors, use exponential backoff
            const waitTime = initialDelay * Math.pow(2, attempt - 1);
            logger.log(
              `Request failed: ${error.message}. Retrying in ${waitTime}ms (attempt ${attempt}/${retries})...`
            );
            await new Promise((resolve) => setTimeout(resolve, waitTime));
          } else {
            throw error;
          }
        }
      }
    },

    async createRecord(values) {
      if (dryRun) {
        // Convert values to human-readable format for logging
        const humanReadableValues = {};
        for (const [attioId, value] of Object.entries(values)) {
          const title = attioIdToTitle[attioId] || attioId;
          humanReadableValues[title] = value;
        }

        logger.log('\nDRY RUN - Would create record:');
        for (const [title, value] of Object.entries(humanReadableValues)) {
          logger.log(`  ${title}: ${JSON.stringify(value, null, 2)}`);
        }
        logger.log('');

        return {
          success: true,
          dryRun: true,
          data: { id: { record_id: 'dry-run-id' } },
        };
      }

      try {
        return await this.makeRequest(async () => {
          const response = await axios.post(
            `${attioBaseUrl}/objects/${objectId}/records`,
            { data: { values } },
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
        logger.error(
          'Error creating record:',
          error.response ? error.response.data : error.message
        );
        return { success: false, error };
      }
    },

    async updateRecord(recordId, values) {
      if (dryRun) {
        // Convert values to human-readable format for logging
        const humanReadableValues = {};
        for (const [attioId, value] of Object.entries(values)) {
          const title = attioIdToTitle[attioId] || attioId;
          humanReadableValues[title] = value;
        }

        logger.log(`\nDRY RUN - Would update record ${recordId}:`);
        for (const [title, value] of Object.entries(humanReadableValues)) {
          logger.log(`  ${title}: ${JSON.stringify(value, null, 2)}`);
        }
        logger.log('');

        return {
          success: true,
          dryRun: true,
          data: { id: { record_id: recordId } },
        };
      }

      try {
        return await this.makeRequest(async () => {
          const response = await axios.put(
            `${attioBaseUrl}/objects/${objectId}/records/${recordId}`,
            { data: { values } },
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
        logger.error(
          `Error updating record ${recordId}:`,
          error.response ? error.response.data : error.message
        );
        return { success: false, error };
      }
    },

    async findRecordByIdentifier(identifierAttributeId, identifierValue) {
      try {
        // Create a special version of makeRequest that doesn't retry 404 errors
        const makeRequestWithout404Retry = async (fn) => {
          try {
            return await fn();
          } catch (error) {
            // If it's a 404 error, return null immediately without retrying
            if (error.response?.status === 404) {
              logger.log(
                `Object or endpoint not found (404). Record not found, should create.`
              );
              return { notFound: true };
            }

            // For other errors, use the regular makeRequest with retries
            return this.makeRequest(fn);
          }
        };

        const result = await makeRequestWithout404Retry(async () => {
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
          if (records.length > 0) {
            logger.log(
              `Found existing record with ${identifierAttributeId}=${identifierValue}`
            );
            return records[0];
          } else {
            logger.log(
              `No record found with ${identifierAttributeId}=${identifierValue}, should create`
            );
            return { notFound: true };
          }
        });

        // If we got a notFound flag, return null to indicate record not found
        if (result && result.notFound) {
          return null;
        }

        return result;
      } catch (error) {
        // For errors other than 404, we should throw the error
        // so it can be properly handled by the calling code
        logger.error(
          `Error finding record:`,
          error.response ? error.response.data : error.message
        );
        throw error;
      }
    },
  };
}

/**
 * Updates the sync status of a record in the database
 */
async function updateSyncStatus(
  client,
  tableName,
  primaryKeyColumn,
  primaryKeyValue,
  status,
  attioExternalId = null,
  dryRun = false
) {
  if (dryRun) {
    logger.log(
      `DRY RUN - Would update sync status for ${primaryKeyColumn}=${primaryKeyValue} to ${status}${
        attioExternalId ? ` with Attio ID ${attioExternalId}` : ''
      }`
    );
    return;
  }

  try {
    const now = new Date();
    let query;
    let params;

    if (attioExternalId) {
      query = `
        UPDATE "${tableName}" 
        SET "attioSyncStatus" = $1, "attioLastSyncedAt" = $2, "attioExternalId" = $3 
        WHERE "${primaryKeyColumn}" = $4
      `;
      params = [status, now, attioExternalId, primaryKeyValue];
    } else {
      query = `
        UPDATE "${tableName}" 
        SET "attioSyncStatus" = $1, "attioLastSyncedAt" = $2 
        WHERE "${primaryKeyColumn}" = $3
      `;
      params = [status, now, primaryKeyValue];
    }

    await client.query(query, params);
  } catch (error) {
    logger.error(
      `Error updating sync status for ${primaryKeyColumn}=${primaryKeyValue}:`,
      error
    );
  }
}

/**
 * Migrates data from PostgreSQL to Attio
 */
async function migrateObjectRecords(options) {
  // First, dynamically import p-limit
  const pLimitModule = await import('p-limit');
  const pLimit = pLimitModule.default;

  const {
    objectId,
    jsonFilePath,
    tableName: configTableName,
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
    skipLookup = false,
    limit = null,
    concurrency = 20, // Default concurrency
    columnFilter = null, // Format: { column: 'columnName', value: 'value' }
    verbose = true, // Default to verbose output
  } = options;

  // Create logger with explicit verbose setting
  const logger = createLogger({ verbose });

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

  // Load attribute mapping
  let attributeMapping;
  try {
    const fileContent = fs.readFileSync(jsonFilePath, 'utf8');
    attributeMapping = JSON.parse(fileContent);
  } catch (err) {
    logger.error('Error reading attribute mapping file:', err);
    throw err;
  }

  // Create mappings from database columns to Attio attributes
  const dbToAttioMapping = {};
  const dbToAttioTypeMapping = {};
  const attioIdToTitle = {}; // Map Attio IDs to human-readable titles
  let identifierAttributeId = null;

  // Track columns that have multiple mappings
  const columnsWithMultipleMappings = {};

  for (const [key, mapping] of Object.entries(attributeMapping)) {
    if (mapping.database && mapping.attio?.attribute_id) {
      const dbColumn = mapping.database.columnName;

      // Track columns with multiple mappings
      if (!columnsWithMultipleMappings[dbColumn]) {
        columnsWithMultipleMappings[dbColumn] = [];
      }
      columnsWithMultipleMappings[dbColumn].push({
        key,
        attributeId: mapping.attio.attribute_id,
        type: mapping.attio.type,
        title: mapping.attio.title || key,
        hasRelationship: !!mapping.attio.relationship,
      });

      dbToAttioMapping[dbColumn] = mapping.attio.attribute_id;
      dbToAttioTypeMapping[dbColumn] = mapping.attio.type;
      attioIdToTitle[mapping.attio.attribute_id] = mapping.attio.title || key;

      // Use the primary key as the identifier for finding records
      if (mapping.database.columnName === primaryKey) {
        identifierAttributeId = mapping.attio.attribute_id;
      }
    }
  }

  // Log columns with multiple mappings
  for (const [column, mappings] of Object.entries(
    columnsWithMultipleMappings
  )) {
    if (mappings.length > 1) {
      logger.log(`Column ${column} has multiple Attio mappings:`);
      for (const mapping of mappings) {
        logger.log(
          `  - ${mapping.key} (${mapping.title}): ${mapping.type}${
            mapping.hasRelationship ? ' (relationship)' : ''
          }`
        );
      }
    }
  }

  if (!identifierAttributeId) {
    throw new Error(
      `Primary key ${primaryKey} not found in attribute mapping or missing attribute_id`
    );
  }

  // Create API client with access to attioIdToTitle
  const api = createAttioApiClient(
    objectId,
    token,
    attioBaseUrl,
    dryRun,
    attioIdToTitle,
    logger
  );

  // Connect to PostgreSQL
  const pool = new Pool(pgConfig);
  let client = null;

  try {
    client = await pool.connect();
    logger.log(`Connected to PostgreSQL database: ${pgConfig.database}`);

    // Ensure tracking columns exist
    await ensureTrackingColumns(client, configTableName);

    // Process attribute mapping to identify relationships
    const relationships = [];
    for (const [key, mapping] of Object.entries(attributeMapping)) {
      if (mapping.attio?.relationship) {
        logger.log(
          `Found relationship: ${key} -> ${JSON.stringify(
            mapping.attio.relationship
          )}`
        );

        // Also check and correct the lookup table name
        const lookupTableName = mapping.attio.relationship.lookupTable;
        const { rows: lookupTableRows } = await client.query(
          `
          SELECT table_name 
          FROM information_schema.tables 
          WHERE table_schema = 'public' 
          AND table_name ILIKE $1
        `,
          [lookupTableName]
        );

        const actualLookupTable =
          lookupTableRows.length > 0
            ? lookupTableRows[0].table_name
            : lookupTableName;

        // Check if the lookup table has the required columns
        const { rows: columnRows } = await client.query(
          `
          SELECT column_name 
          FROM information_schema.columns 
          WHERE table_name = $1 
          AND column_name IN ($2, 'attioExternalId')
        `,
          [actualLookupTable, mapping.attio.relationship.lookupColumn]
        );

        const hasLookupColumn = columnRows.some(
          (row) => row.column_name === mapping.attio.relationship.lookupColumn
        );
        const hasAttioId = columnRows.some(
          (row) => row.column_name === 'attioExternalId'
        );

        if (!hasLookupColumn) {
          logger.warn(
            `Warning: Lookup column "${mapping.attio.relationship.lookupColumn}" not found in table "${actualLookupTable}"`
          );
        }

        if (!hasAttioId) {
          logger.warn(
            `Warning: Column "attioExternalId" not found in lookup table "${actualLookupTable}". Make sure to migrate this table first.`
          );
        }

        relationships.push({
          dbColumn: mapping.database.columnName,
          attioAttributeId: mapping.attio.attribute_id,
          attioType: mapping.attio.type,
          targetObject: mapping.attio.relationship.targetObject,
          lookupTable: actualLookupTable,
          lookupColumn: mapping.attio.relationship.lookupColumn,
          title: mapping.attio.title || key,
        });
      }
    }

    // Debug relationships
    logger.log(`Found ${relationships.length} relationships:`);
    for (const rel of relationships) {
      logger.log(
        `- ${rel.title} (${rel.dbColumn}) -> ${rel.lookupTable}.${rel.lookupColumn}`
      );
    }

    // Build the SQL query with joins for relationships
    let sqlQuery = `SELECT t.*, `;
    const joinClauses = [];

    // Add columns for each relationship to get the Attio IDs directly
    for (let i = 0; i < relationships.length; i++) {
      const rel = relationships[i];
      sqlQuery += `r${i}."attioExternalId" AS "${rel.dbColumn}_attioId_${i}", `;
      joinClauses.push(
        `LEFT JOIN "${rel.lookupTable}" r${i} ON t."${rel.dbColumn}" = r${i}."${rel.lookupColumn}"`
      );
    }

    // Remove trailing comma and space
    if (relationships.length > 0) {
      sqlQuery = sqlQuery.slice(0, -2);
    } else {
      sqlQuery = `SELECT t.*`; // If no relationships, just select all columns
    }

    // Complete the query with the FROM clause and joins
    sqlQuery += ` FROM "${configTableName}" t`;
    if (joinClauses.length > 0) {
      sqlQuery += ` ${joinClauses.join(' ')}`;
    }

    // Build the query based on sync options
    let whereConditions = [];
    let params = [];
    let paramIndex = 1;

    if (!fullSync) {
      if (retryFailed) {
        whereConditions.push(`t."attioSyncStatus" = 'failed'`);
      } else {
        whereConditions.push(`(
          t."attioLastSyncedAt" IS NULL OR 
          t."updatedAt" > t."attioLastSyncedAt" OR 
          t."attioSyncStatus" = 'failed'
        )`);
      }
    }

    if (since) {
      whereConditions.push(`t."updatedAt" >= $${paramIndex}`);
      params.push(new Date(since));
      paramIndex++;
    }

    // Add custom column filter if provided
    if (
      columnFilter &&
      columnFilter.column &&
      columnFilter.value !== undefined
    ) {
      whereConditions.push(`t."${columnFilter.column}" = $${paramIndex}`);
      params.push(columnFilter.value);
      paramIndex++;
      logger.log(`Filtering by ${columnFilter.column} = ${columnFilter.value}`);
    }

    const whereClause =
      whereConditions.length > 0
        ? `WHERE ${whereConditions.join(' AND ')}`
        : '';

    // Get total count of records to process
    const countQuery = `SELECT COUNT(*) FROM "${configTableName}" t ${whereClause}`;
    const countResult = await client.query(countQuery, params);
    let totalRecords = parseInt(countResult.rows[0].count, 10);

    // Apply limit if provided
    if (limit !== null && limit > 0) {
      totalRecords = Math.min(totalRecords, limit);
      logger.log(
        `Limiting to ${totalRecords} records (out of ${countResult.rows[0].count} total)`
      );
    }

    // Ensure concurrency is a valid number
    const concurrencyLimit = Math.min(
      Math.max(1, parseInt(concurrency, 10) || 20),
      25
    );
    logger.log(`Using concurrency limit: ${concurrencyLimit}`);

    // Create the limiter with the validated concurrency value
    const apiLimiter = pLimit(concurrencyLimit);

    // Process records in batches
    for (let offset = 0; offset < totalRecords; offset += batchSize) {
      logger.log(
        `Processing batch: ${offset + 1} to ${Math.min(
          offset + batchSize,
          totalRecords
        )}`
      );

      // Calculate the effective batch size for this iteration
      const effectiveBatchSize = Math.min(batchSize, totalRecords - offset);

      // Fetch a batch of records
      const batchQueryParams = [...params, effectiveBatchSize, offset];
      const query = `
        ${sqlQuery} 
        ${whereClause} 
        ORDER BY t."updatedAt" 
        LIMIT $${paramIndex} OFFSET $${paramIndex + 1}
      `;

      const result = await client.query(query, batchQueryParams);

      // Process records concurrently within the batch
      const processingPromises = [];

      for (const record of result.rows) {
        processingPromises.push(
          apiLimiter(async () => {
            stats.processed++;
            const recordId = record[primaryKey];

            // Convert PostgreSQL record to Attio values format
            const attioValues = {};
            const humanReadableValues = {}; // For logging purposes

            // Process regular columns first
            for (const [dbColumn, value] of Object.entries(record)) {
              // Skip the relationship ID columns we added (they end with _attioId_X)
              if (/_attioId_\d+$/.test(dbColumn)) continue;

              // Check if this column has multiple mappings
              const multipleMappings = columnsWithMultipleMappings[dbColumn];
              if (
                multipleMappings &&
                multipleMappings.length > 1 &&
                value !== null
              ) {
                // Process each mapping for this column
                for (const mapping of multipleMappings) {
                  // Skip relationship mappings for now, they'll be handled later
                  if (mapping.hasRelationship) continue;

                  // Process non-relationship mapping
                  const attioAttributeId = mapping.attributeId;
                  const attioType = mapping.type;
                  const convertedValue = convertValueForAttio(value, attioType);
                  attioValues[attioAttributeId] = convertedValue;

                  // Store human-readable version for logging
                  humanReadableValues[mapping.title] = convertedValue;
                }
              } else if (dbToAttioMapping[dbColumn] && value !== null) {
                // Regular field processing (non-relationship fields)
                if (!relationships.some((r) => r.dbColumn === dbColumn)) {
                  const attioAttributeId = dbToAttioMapping[dbColumn];
                  const attioType = dbToAttioTypeMapping[dbColumn];
                  const convertedValue = convertValueForAttio(value, attioType);
                  attioValues[attioAttributeId] = convertedValue;

                  // Store human-readable version for logging
                  const attributeTitle =
                    attioIdToTitle[attioAttributeId] || dbColumn;
                  humanReadableValues[attributeTitle] = convertedValue;
                }
              }
            }

            // Now process relationship fields
            for (let i = 0; i < relationships.length; i++) {
              const rel = relationships[i];
              const dbColumn = rel.dbColumn;
              const value = record[dbColumn];

              if (value !== null) {
                // Get the Attio ID from the joined data using the unique column alias
                const relatedAttioId = record[`${dbColumn}_attioId_${i}`];
                const attributeTitle =
                  attioIdToTitle[rel.attioAttributeId] || rel.title || dbColumn;

                if (relatedAttioId) {
                  if (dryRun) {
                    logger.log(
                      `DRY RUN - Using joined relationship for ${attributeTitle}=${value} to Attio ID ${relatedAttioId}`
                    );
                  } else {
                    logger.log(
                      `Using joined relationship for ${attributeTitle}=${value} to Attio ID ${relatedAttioId}`
                    );
                  }

                  // Format based on the attribute type
                  if (rel.attioType === 'record-reference') {
                    // Format for record-reference type
                    attioValues[rel.attioAttributeId] = [
                      {
                        target_record_id: relatedAttioId,
                        target_object: rel.targetObject,
                      },
                    ];

                    // Store human-readable version for logging
                    humanReadableValues[
                      attributeTitle
                    ] = `[${rel.targetObject} record: ${relatedAttioId}]`;
                  } else {
                    // For other relationship types
                    attioValues[rel.attioAttributeId] = relatedAttioId;
                    humanReadableValues[attributeTitle] = relatedAttioId;
                  }
                } else {
                  // Check if the related record exists but has no attioExternalId
                  const { rows: relatedRows } = await client.query(
                    `
                    SELECT * FROM "${rel.lookupTable}" 
                    WHERE "${rel.lookupColumn}" = $1
                  `,
                    [value]
                  );

                  if (relatedRows.length > 0) {
                    if (relatedRows[0].attioExternalId) {
                      logger.warn(
                        `${
                          dryRun ? 'DRY RUN - ' : ''
                        }Warning: Related record found for ${attributeTitle}=${value} but join failed. This might be a bug.`
                      );
                    } else {
                      logger.warn(
                        `${
                          dryRun ? 'DRY RUN - ' : ''
                        }Warning: Related record found for ${attributeTitle}=${value} but it has no attioExternalId. Run migration for ${
                          rel.targetObject
                        } first.`
                      );
                    }
                  } else {
                    logger.warn(
                      `${
                        dryRun ? 'DRY RUN - ' : ''
                      }Warning: No related record found for ${attributeTitle}=${value} in table ${
                        rel.lookupTable
                      }`
                    );
                  }
                }
              }
            }

            // Log the values being sent to Attio in dry run mode
            if (dryRun) {
              logger.log(
                `DRY RUN - Would process record with ${primaryKey}=${recordId} with values:`
              );
              for (const [title, value] of Object.entries(
                humanReadableValues
              )) {
                logger.log(`  ${title}: ${JSON.stringify(value)}`);
              }
            }

            try {
              // If we already have an Attio external ID, update directly
              if (record.attioExternalId) {
                logger.log(`Updating record with ${primaryKey}=${recordId}`);
                const result = await api.updateRecord(
                  record.attioExternalId,
                  attioValues
                );

                if (result.success) {
                  await updateSyncStatus(
                    client,
                    configTableName,
                    primaryKey,
                    recordId,
                    'synced',
                    record.attioExternalId,
                    dryRun
                  );
                  stats.updated++;
                  logger.log(
                    `Successfully updated record with ${primaryKey}=${recordId}`
                  );
                } else {
                  await updateSyncStatus(
                    client,
                    configTableName,
                    primaryKey,
                    recordId,
                    'failed',
                    null,
                    dryRun
                  );
                  stats.failed++;
                  logger.error(
                    `Failed to update record with ${primaryKey}=${recordId}`
                  );
                }
              } else if (skipLookup) {
                // Skip lookup and directly create new records
                logger.log(
                  `Creating new record with ${primaryKey}=${recordId} (lookup skipped)`
                );
                const result = await api.createRecord(attioValues);

                if (result.success) {
                  const attioRecordId = result.data.id.record_id;
                  await updateSyncStatus(
                    client,
                    configTableName,
                    primaryKey,
                    recordId,
                    'synced',
                    attioRecordId,
                    dryRun
                  );
                  stats.created++;
                  logger.log(
                    `Successfully created record with ${primaryKey}=${recordId}`
                  );
                } else {
                  await updateSyncStatus(
                    client,
                    configTableName,
                    primaryKey,
                    recordId,
                    'failed',
                    null,
                    dryRun
                  );
                  stats.failed++;
                  logger.error(
                    `Failed to create record with ${primaryKey}=${recordId}`
                  );
                }
              } else {
                // For lookup + write scenario
                logger.log(`Looking up record with ${primaryKey}=${recordId}`);
                const lookupResult = await api.findRecordByIdentifier(
                  identifierAttributeId,
                  String(recordId)
                );

                if (!lookupResult) {
                  logger.log(
                    `Record ${record[primaryKey]} not found in Attio, will create new record`
                  );
                  // Set action to 'create'
                  action = 'create';
                } else if (lookupResult) {
                  // Record exists, update it
                  action = 'update';
                } else {
                  // Some other error occurred during lookup
                  action = 'skip';
                }

                if (action === 'create') {
                  logger.log(
                    `Creating new record with ${primaryKey}=${recordId}`
                  );
                  const result = await api.createRecord(attioValues);

                  if (result.success) {
                    const attioRecordId = result.data.id.record_id;
                    await updateSyncStatus(
                      client,
                      configTableName,
                      primaryKey,
                      recordId,
                      'synced',
                      attioRecordId,
                      dryRun
                    );
                    stats.created++;
                    logger.log(
                      `Successfully created record with ${primaryKey}=${recordId}`
                    );
                  } else {
                    await updateSyncStatus(
                      client,
                      configTableName,
                      primaryKey,
                      recordId,
                      'failed',
                      null,
                      dryRun
                    );
                    stats.failed++;
                    logger.error(
                      `Failed to create record with ${primaryKey}=${recordId}`
                    );
                  }
                } else if (action === 'update') {
                  logger.log(`Updating record with ${primaryKey}=${recordId}`);
                  const result = await api.updateRecord(
                    lookupResult.id.record_id,
                    attioValues
                  );

                  if (result.success) {
                    await updateSyncStatus(
                      client,
                      configTableName,
                      primaryKey,
                      recordId,
                      'synced',
                      lookupResult.id.record_id,
                      dryRun
                    );
                    stats.updated++;
                    logger.log(
                      `Successfully updated record with ${primaryKey}=${recordId}`
                    );
                  } else {
                    await updateSyncStatus(
                      client,
                      configTableName,
                      primaryKey,
                      recordId,
                      'failed',
                      null,
                      dryRun
                    );
                    stats.failed++;
                    logger.error(
                      `Failed to update record with ${primaryKey}=${recordId}`
                    );
                  }
                } else {
                  logger.log(`Skipping record with ${primaryKey}=${recordId}`);
                }
              }
            } catch (error) {
              logger.error(
                `Error processing record ${primaryKey}=${recordId}:`,
                error
              );
              await updateSyncStatus(
                client,
                configTableName,
                primaryKey,
                recordId,
                'failed',
                null,
                dryRun
              );
              stats.failed++;
            }
          })
        );
      }

      // Wait for all records in the batch to be processed
      await Promise.all(processingPromises);
    }

    if (dryRun) {
      logger.log(`
DRY RUN - Migration summary (no actual changes were made):
  Processed: ${stats.processed}
  Would create: ${stats.created}
  Would update: ${stats.updated}
  Would fail: ${stats.failed}
      `);
    } else {
      logger.log(`
Migration completed:
  Processed: ${stats.processed}
  Created: ${stats.created}
  Updated: ${stats.updated}
  Failed: ${stats.failed}
      `);
    }

    // Make sure to close the logger at the end
    await logger.close();

    return { ...stats, logFile: logger.getLogFilePath() };
  } catch (err) {
    logger.error('Error during migration:', err);
    throw err;
  } finally {
    if (client) {
      try {
        client.release();
      } catch (e) {
        logger.error('Error releasing client:', e);
      }
    }

    try {
      await pool.end();
    } catch (e) {
      logger.error('Error ending pool:', e);
    }
  }
}

/**
 * Runs the migration repeatedly until all eligible records are processed
 */
async function migrateUntilComplete(options, maxAttempts = 5) {
  let attempt = 1;
  let totalStats = { processed: 0, created: 0, updated: 0, failed: 0 };

  while (attempt <= maxAttempts) {
    logger.log(`\n=== Migration Attempt ${attempt}/${maxAttempts} ===\n`);

    // Run the migration with the same options each time
    // This will pick up any records that still need syncing
    const result = await migrateObjectRecords(options);

    // Accumulate stats
    totalStats.processed += result.processed;
    totalStats.created += result.created;
    totalStats.updated += result.updated;
    totalStats.failed += result.failed;

    logger.log(
      `\nAttempt ${attempt} completed - processed ${result.processed} records`
    );

    // If no records were processed in this run, we're done
    if (result.processed === 0) {
      logger.log('No more records to process!');
      break;
    }

    // Wait a bit before the next attempt
    logger.log(`Waiting 5 seconds before next attempt...`);
    await new Promise((resolve) => setTimeout(resolve, 5000));

    attempt++;
  }

  if (attempt > maxAttempts) {
    logger.log(
      `\nReached maximum attempts (${maxAttempts}). Some records may still need processing.`
    );
  }

  return totalStats;
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
  let skipLookup = false;
  let limit = null;
  let concurrency = null;
  let filterColumn = null;
  let filterValue = null;
  let untilComplete = false;
  let maxAttempts = 5;
  let verbose = false; // Default to minimal logging

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
    } else if (args[i] === '--skip-lookup') {
      skipLookup = true;
    } else if (args[i] === '--limit' && i + 1 < args.length) {
      limit = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--concurrency' && i + 1 < args.length) {
      concurrency = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--filter-column' && i + 1 < args.length) {
      filterColumn = args[i + 1];
      i++;
    } else if (args[i] === '--filter-value' && i + 1 < args.length) {
      filterValue = args[i + 1];
      i++;
    } else if (args[i] === '--until-complete') {
      untilComplete = true;
    } else if (args[i] === '--max-attempts' && i + 1 < args.length) {
      maxAttempts = parseInt(args[i + 1], 10);
      i++;
    } else if (args[i] === '--verbose') {
      verbose = true;
    }
  }

  // Validate arguments
  if (!objectName || !objectConfigs[objectName]) {
    console.error(`
Error: Invalid or missing object name.
Usage: 
  node migrateObjectRecords.js --object <objectName> [--dry-run] [--batch-size <number>] [--full-sync] [--retry-failed] [--since <date>] [--skip-lookup] [--limit <number>] [--concurrency <number>] [--filter-column <column>] [--filter-value <value>] [--until-complete] [--max-attempts <number>] [--verbose]

Available objects: ${Object.keys(objectConfigs).join(', ')}
    `);
    process.exit(1);
  }

  // Configure migration options
  const migrationConfig = {
    ...objectConfigs[objectName],
    objectName,
    dryRun,
    fullSync,
    retryFailed,
    since,
    skipLookup,
    limit,
    concurrency,
    columnFilter:
      filterColumn && filterValue
        ? { column: filterColumn, value: filterValue }
        : null,
    verbose,
  };

  if (batchSize) {
    migrationConfig.batchSize = batchSize;
  }

  // Create a logger for the main process
  const mainLogger = createLogger({ verbose });

  // Run the migration
  const migrationPromise = untilComplete
    ? migrateUntilComplete(migrationConfig, maxAttempts)
    : migrateObjectRecords(migrationConfig);

  migrationPromise
    .then(async (result) => {
      mainLogger.important(`
Migration summary:
  Processed: ${result.processed}
  Created: ${result.created}
  Updated: ${result.updated}
  Failed: ${result.failed}
      `);

      process.exit(0);
    })
    .catch(async (error) => {
      mainLogger.error('Unhandled error in main process:', error);
      process.exit(1);
    });
}

// Export the migration functions for use in other scripts
module.exports = { migrateObjectRecords, migrateUntilComplete };
