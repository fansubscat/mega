import { e64, d64, prepareKey, prepareKeyV2, formatKey, AES, constantTimeCompare } from './crypto/index.mjs'
import { cryptoDecodePrivKey, cryptoRsaDecrypt } from './crypto/rsa.mjs'
import API from './api.mjs'
import { EventEmitter } from 'events'
import MutableFile from './mutable-file.mjs'
import { createPromise } from './util.mjs'

class Storage extends EventEmitter {
  constructor (options, originalCb) {
    super()

    if (arguments.length === 1 && typeof options === 'function') {
      originalCb = options
      options = {}
    }

    // Because this is a constructor it can't return a promise
    // so the promise is make available via .ready
    const [cb, promise] = createPromise(originalCb)
    this.ready = promise

    // Defaults
    options.keepalive = options.keepalive === undefined ? true : !!options.keepalive
    options.autoload = options.autoload === undefined ? true : !!options.autoload
    options.autologin = options.autologin === undefined ? true : !!options.autologin

    this.api = new API(options.keepalive, options)
    this.files = {}
    this.options = options
    this.status = 'closed'

    if (options.autologin) {
      this.login(cb)
    } else {
      process.nextTick(() => {
        cb(null, this)
      })
    }
  }

  login (originalCb) {
    const [cb, promise] = createPromise(originalCb)

    if (typeof this.options.email !== 'string') {
      process.nextTick(() => {
        cb(Error("starting a session without credentials isn't supported"))
      })
      return promise
    }

    const ready = () => {
      this.status = 'ready'
      cb(null, this)
      this.emit('ready', this)
    }

    const loadUser = (cb) => {
      this.api.request({ a: 'ug' }, (err, response) => {
        if (err) return cb(err)
        this.name = response.name
        this.user = response.u

        if (this.options.autoload) {
          this.reload(true, err => {
            if (err) return cb(err)
            ready()
          })
        } else {
          ready()
        }
      })
    }

    // MEGA lower cases email addresses (issue #40)
    this.email = this.options.email.toLowerCase()

    const handleV1Account = (cb) => {
      const pw = prepareKey(Buffer.from(this.options.password))

      // after generating the AES key the password isn't needed anymore
      delete this.options.password

      const aes = new AES(pw)
      const uh = e64(aes.stringhash(Buffer.from(this.email)))
      const request = { a: 'us', user: this.email, uh }
      finishLogin(request, aes, cb)
    }

    const handleV2Account = (info, cb) => {
      prepareKeyV2(Buffer.from(this.options.password), info, (err, result) => {
        if (err) return cb(err)

        // after generating the AES key the password isn't needed anymore
        delete this.options.password

        const aes = new AES(result.slice(0, 16))
        const uh = e64(result.slice(16))
        const request = { a: 'us', user: this.email, uh }
        finishLogin(request, aes, cb)
      })
    }

    const finishLogin = (request, aes, cb) => {
      this.api.request(request, (err, response) => {
        if (err) return cb(err)
        this.key = formatKey(response.k)
        aes.decryptECB(this.key)
        this.aes = new AES(this.key)

        const t = formatKey(response.csid)
        const privk = this.aes.decryptECB(formatKey(response.privk))
        const rsaPrivk = cryptoDecodePrivKey(privk)
        if (!rsaPrivk) throw Error('invalid credentials')

        const sid = e64(cryptoRsaDecrypt(t, rsaPrivk).slice(0, 43))

        this.api.sid = this.sid = sid
        this.RSAPrivateKey = rsaPrivk

        loadUser(cb)
      })
    }

    this.api.request({ a: 'us0', user: this.email }, (err, response) => {
      if (err) return cb(err)
      if (response.v === 1) return handleV1Account(cb)
      if (response.v === 2) return handleV2Account(response, cb)
      cb(Error('Account version not supported'))
    })

    this.status = 'connecting'
    return promise
  }

  reload (force, originalCb) {
    if (typeof force === 'function') [force, originalCb] = [originalCb, force]
    const [cb, promise] = createPromise(originalCb)

    if (this.status === 'connecting' && !force) {
      this.once('ready', () => {
        this.reload(force, cb)
      })
      return promise
    }

    this.mounts = []
    this.api.request({ a: 'f', c: 1 }, (err, response) => {
      if (err) return cb(err)

      this.shareKeys = response.ok.reduce((shares, share) => {
        const handler = share.h

        // MEGA handles share authenticity by checking the value below
        const auth = this.aes.encryptECB(Buffer.from(handler + handler))

        // original implementation doesn't compare in constant time, but...
        if (constantTimeCompare(formatKey(share.ha), auth)) {
          shares[handler] = this.aes.decryptECB(formatKey(share.k))
        }

        // If verification fails the share was tampered... by MEGA servers.
        // Well, never trust the server, the code says...

        return shares
      }, {})

      response.f.forEach(file => {
        file = this._importFile(file)

        // If the account have no links "ph" is undefined.
        if (response.ph !== undefined) {
          file.shareId = response.ph.find(item => item.h === file.nodeId)?.ph
          file.shared = !!file.shareId

          if (file.shared) {
            file.shareURL = `https://mega.nz/${file.directory ? 'folder' : 'file'}/${file.shareId}`
            if (file.key) file.shareURL += `#${e64(file.directory ? this.shareKeys[file.nodeId] : file.key)}`
          }
        }
      })
      cb(null, this.mounts)
    })

    this.api.on('sc', arr => {
      const deleted = {}
      arr.forEach(o => {
        if (o.a === 'u') {
          const file = this.files[o.n]
          if (file) {
            file.timestamp = o.ts
            file.decryptAttributes(o.at)
            file.emit('update')
            this.emit('update', file)
          }
        } else if (o.a === 'd') {
          deleted[o.n] = true // Don't know yet if move or delete.
        } else if (o.a === 't') {
          o.t.f.forEach(f => {
            const file = this.files[f.h]
            if (file) {
              delete deleted[f.h]
              const oldparent = file.parent
              if (oldparent.nodeId === f.p) return
              // todo: move to setParent() to avoid duplicate.
              oldparent.children.splice(oldparent.children.indexOf(file), 1)
              file.parent = this.files[f.p]
              if (!file.parent.children) file.parent.children = []
              file.parent.children.push(file)
              file.emit('move', oldparent)
              this.emit('move', file, oldparent)
            } else {
              this.emit('add', this._importFile(f))
            }
          })
        }
      })

      Object.keys(deleted).forEach(n => {
        const file = this.files[n]
        const parent = file.parent
        parent.children.splice(parent.children.indexOf(file), 1)
        this.emit('delete', file)
        file.emit('delete')
      })
    })

    return promise
  }

  _importFile (f) {
    // todo: no support for updates
    if (!this.files[f.h]) {
      const file = this.files[f.h] = new MutableFile(f, this)
      if (f.t === NODE_TYPE_DRIVE) {
        this.root = file
        file.name = 'Cloud Drive'
      }
      if (f.t === NODE_TYPE_RUBBISH_BIN) {
        this.trash = file
        file.name = 'Rubbish Bin'
      }
      if (f.t === NODE_TYPE_INBOX) {
        this.inbox = file
        file.name = 'Inbox'
      }
      if (f.t > 1) {
        this.mounts.push(file)
      }
      if (f.p) {
        const parent = this.files[f.p]

        // Issue 58: some accounts have orphan files
        if (parent) {
          if (!parent.children) parent.children = []
          parent.children.push(file)
          file.parent = parent
        }
      }
    }
    return this.files[f.h]
  }

  // alternative to this.root.mkdir
  mkdir (opt, cb) {
    if (this.status !== 'ready') {
      throw Error('storage is not ready')
    }
    return this.root.mkdir(opt, cb)
  }

  // alternative to this.root.upload
  upload (opt, buffer, cb) {
    if (this.status !== 'ready') {
      throw Error('storage is not ready')
    }
    return this.root.upload(opt, buffer, cb)
  }

  close (cb) {
    // Does not handle still connecting or incomplete streams
    this.status = 'closed'
    this.api.close()

    // Call the "Session Management Logout" API call
    return this.api.request({ a: 'sml' }, cb)
  }

  getAccountInfo (originalCb) {
    const [cb, promise] = createPromise(originalCb)

    this.api.request({ a: 'uq', strg: 1, xfer: 1, pro: 1 }, (err, response) => {
      if (err) cb(err)
      const account = {}

      // Normalize responses from API
      account.type = response.utype
      account.spaceUsed = response.cstrg
      account.spaceTotal = response.mstrg
      account.downloadBandwidthTotal = response.mxfer || Math.pow(1024, 5) * 10
      account.downloadBandwidthUsed = response.caxfer || 0
      account.sharedBandwidthUsed = response.csxfer || 0
      account.sharedBandwidthLimit = response.srvratio

      cb(null, account)
    })

    return promise
  }

  toJSON () {
    return {
      key: e64(this.key),
      sid: this.sid,
      name: this.name,
      user: this.user,
      options: this.options
    }
  }

  static fromJSON (json) {
    const storage = new Storage(Object.assign(json.options, {
      autoload: false,
      autologin: false
    }))

    storage.key = d64(json.key)
    storage.aes = new AES(storage.key)
    storage.api.sid = storage.sid = json.sid
    storage.name = json.name
    storage.user = json.user

    return storage
  }
}

const NODE_TYPE_DRIVE = 2
const NODE_TYPE_INBOX = 3
const NODE_TYPE_RUBBISH_BIN = 4

export default Storage
