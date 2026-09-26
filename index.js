const { default: makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys")
const { RouterOSClient } = require("routeros-client")
const QRCode = require('qrcode')
const fs = require('fs')
const qrcode = require('qrcode-terminal')

// DATABASE SIMPLE (nanti ganti Supabase)
let db = {
  juragan: {
    // "62812xxxx@s.whatsapp.net": { mt_host: "1.2.3.4", mt_user: "admin", mt_pass: "123", pppoe_clients: ["rudi", "andi"] }
  },
  clients: {
    // "62898xxxx@s.whatsapp.net": { pppoe_user: "rudi", pppoe_ip: "10.10.10.5", juragan_id: "62812xxxx@s.whatsapp.net" }
  }
}

async function connectMikrotik(juraganId){
  const j = db.juragan[juraganId]
  const client = new RouterOSClient({ host: j.mt_host, user: j.mt_user, password: j.mt_pass })
  return await client.connect()
}

async function startJuragan(juraganId){
  const { state, saveCreds } = await useMultiFileAuthState(`./session/${juraganId}`)
  const sock = makeWASocket({ auth: state, logger: require('pino')({level:'silent'}), printQRInTerminal: true })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    if(update.qr){
      console.log(`QR JURAGAN ${juraganId}:`)
      console.log(await QRCode.toString(update.qr, {type:'terminal'}))
    }
  })

  sock.ev.on('messages.upsert', async ({messages}) => {
    const msg = messages[0]
    if(!msg.message || msg.key.fromMe) return
    const from = msg.key.remoteJid
    const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase()

    // CEK ROLE
    let isJuragan = db.juragan[from]
    let clientData = db.clients[from]
    let juraganOwnerId = clientData? clientData.juragan_id : (isJuragan? from : null)
    if(!juraganOwnerId) return

    try{
      const ros = await connectMikrotik(juraganOwnerId)

      // === FITUR CLIENT: /cek ===
      if(text === '/cek' || text === '/cekperangkat'){
        let pppActive = await ros.menu('/ppp active').getAll()
        let myPpp = pppActive.find(p => p.name === clientData?.pppoe_user)
        let dhcp = await ros.menu('/ip dhcp-server lease').getAll()

        let reply = `📡 Perangkat di PPoE ${clientData.pppoe_user}:\n`
        dhcp.slice(0,10).forEach((d,i)=>{
          reply += `${i+1}. ${d['host-name']||'Unknown'} - ${d.address} - ${d['mac-address']}\n`
        })
        reply += `\nKetik /blokir [IP] atau /restart`
        sock.sendMessage(from, {text: reply})
        ros.close()
      }

      // === FITUR CLIENT: /blokir ===
      if(text.startsWith('/blokir')){
        let ip = text.split(' ')[1]
        await ros.menu('/ip firewall filter').add({ chain:'forward', srcAddress: ip, action:'drop', comment:`blok by ${from}` })
        sock.sendMessage(from, {text: `✅ ${ip} diblokir! /buka ${ip} untuk buka`})
        ros.close()
      }

      // === FITUR CLIENT: /restart ===
      if(text === '/restart'){
        let active = await ros.menu('/ppp active').getAll()
        let target = active.find(a => a.name === clientData.pppoe_user)
        if(target){
          await ros.menu('/ppp active').remove(target['.id'])
          sock.sendMessage(from, {text: `🔄 Modem ${clientData.pppoe_user} direstart, tunggu 30 detik...`})
        }
        ros.close()
      }

      // === FITUR JURAGAN ===
      if(isJuragan && text === '/cek all'){
        let all = await ros.menu('/ppp active').getAll()
        sock.sendMessage(from, {text: `Total PPoE aktif: ${all.length}`})
        ros.close()
      }

    } catch(e){
      sock.sendMessage(from, {text: `Error: ${e.message}`})
    }
  })
}

// JALANIN SEMUA JURAGAN YANG ADA DI DB
// Contoh manual dulu, nanti ambil dari Supabase
// startJuragan('62812xxxx@s.whatsapp.net')

console.log("Bot siap, tambahin juragan di db.juragan dulu co!")
// Untuk test, uncomment baris atas dan isi db manual
