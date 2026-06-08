const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', '..', 'data');

class JsonStore {
  constructor(entityName) {
    this.entityName = entityName;
    this.filePath = path.join(DATA_DIR, `${entityName}.json`);
    this.ensureDataDir();
    this.ensureFile();
  }

  ensureDataDir() {
    if (!fs.existsSync(DATA_DIR)) {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    }
  }

  ensureFile() {
    if (!fs.existsSync(this.filePath)) {
      fs.writeFileSync(this.filePath, JSON.stringify([], null, 2), 'utf-8');
    }
  }

  readAll() {
    try {
      const content = fs.readFileSync(this.filePath, 'utf-8');
      return JSON.parse(content);
    } catch (err) {
      console.error(`Error reading ${this.entityName}:`, err);
      return [];
    }
  }

  writeAll(data) {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(data, null, 2), 'utf-8');
      return true;
    } catch (err) {
      console.error(`Error writing ${this.entityName}:`, err);
      return false;
    }
  }

  append(record) {
    const data = this.readAll();
    data.push(record);
    return this.writeAll(data);
  }

  findById(id) {
    const data = this.readAll();
    return data.find(item => item.id === id);
  }

  findOne(predicate) {
    const data = this.readAll();
    return data.find(predicate);
  }

  findMany(predicate) {
    const data = this.readAll();
    if (!predicate) return data;
    return data.filter(predicate);
  }

  updateById(id, updater) {
    const data = this.readAll();
    const index = data.findIndex(item => item.id === id);
    if (index === -1) return null;
    data[index] = updater(data[index]);
    this.writeAll(data);
    return data[index];
  }

  replaceById(id, newRecord) {
    const data = this.readAll();
    const index = data.findIndex(item => item.id === id);
    if (index === -1) return null;
    data[index] = { ...data[index], ...newRecord };
    this.writeAll(data);
    return data[index];
  }
}

class AuditLogStore extends JsonStore {
  constructor() {
    super('audit_logs');
  }

  append(record) {
    const data = this.readAll();
    const recordWithSeq = {
      ...record,
      sequence: data.length + 1,
      timestamp: record.timestamp || new Date().toISOString()
    };
    data.push(recordWithSeq);
    return this.writeAll(data);
  }
}

module.exports = {
  JsonStore,
  AuditLogStore,
  DATA_DIR
};
