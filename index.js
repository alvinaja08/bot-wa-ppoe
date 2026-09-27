const { default: makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys")
const { RouterOSClient } = require("routeros-client")
const QRCode = require('qrcode')
const qrcode = require('qrcode-terminal')
const { createClient } = require('@supabase/supabase-js')
const pino = require('pino')

// KONEK SUPABASE - AMBIL DARI RAILWAY VARIABLES
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

async function getDB(){
  let { data: juraganList } = await supabase.from('juragan').select('*')
  let { data: clientList } = await supabase.from('clients').select('*')
  let db = { juragan: {}, clients: {} }
  juraganList?.forEach(j => { db.juragan[j.id] = j })
  clientList?.forEach(c => { db.clients[c.id] = c })
  return db
}

async function connectMikrotik(juraganId){
  let { data: j, error } = await supabase.from('juragan').select('*').eq('id', juraganId).single()
  if(error) throw new Error(`Juragan ${juraganId} tidak ada di DB`)
  const client = new RouterOSClient({
    host: j.mt_host,
    user: j.mt_user,
    password: j.mt_pass,
    keepalive: true
  })
  return await client.connect()
}

async function startJuragan(juraganId){
  const { state, saveCreds } = await useMultiFileAuthState(`./session/${juraganId}`)
  const sock = makeWASocket({
    auth: state,
    logger: pino({level:'silent'}),
    printQRInTerminal: true
  })

  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, lastDisconnect, qr } = update
    if(qr){
      console.log(`\n=== QR JURAGAN ${juraganId} ===`)
      console.log(await QRCode.toString(qr, {type:'terminal', small:true}))
      console.log(`============================\n`)
    }
    if(connection === 'open'){
      console.log(`✅ Juragan ${juraganId} CONNECTED!`)
    }
    if(connection === 'close'){
      console.log(`❌ Juragan ${juraganId} disconnect, reconnecting...`)
      setTimeout(() => startJuragan(juraganId), 3000)
    }
  })

  sock.ev.on('messages.upsert', async ({messages}) => {
    const msg = messages[0]
    if(!msg.message || msg.key.fromMe) return
    const from = msg.key.remoteJid
    const text = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").toLowerCase().trim()

    let db = await getDB()
    let isJuragan = db.juragan[from]
    let clientData = db.clients[from]
    let juraganOwnerId = clientData?.juragan_id || (isJuragan? from : null)
    if(!juraganOwnerId) return

    try{
      const ros = await connectMikrotik(juraganOwnerId)

      if(text === '/cek' || text === '/cekperangkat'){
        let dhcp = await ros.menu('/ip dhcp-server lease').getAll()
        let reply = `📡 *Perangkat di PPoE ${clientData.pppoe_user}:*\n\n`
        dhcp.slice(0,15).forEach((d,i)=>{
          reply += `${i+1}. ${d['host-name']||'Unknown'} - ${d.address} - ${d['mac-address']}\n`
        })
        reply += `\nKetik /blokir [IP] atau /restart`
        await sock.sendMessage(from, {text: reply})
        ros.close()
      }

      if(text.startsWith('/blokir ')){
        let ip = text.split(' ')[1]
        if(!ip) return sock.sendMessage(from, {text: `Format: /blokir 192.168.1.10`})
        await ros.menu('/ip firewall filter').add({ chain:'forward', srcAddress: ip, action:'drop', comment:`blok by ${from}` })
        await sock.sendMessage(from, {text: `✅ ${ip} diblokir! /buka ${ip} untuk buka`})
        ros.close()
      }

      if(text.startsWith('/buka ')){
        let ip = text.split(' ')[1]
        let filters = await ros.menu('/ip firewall filter').getAll()
        let target = filters.find(f => f.srcAddress === ip && f.comment?.includes(from))
        if(target){
          await ros.menu('/ip firewall filter').remove(target['.id'])
          await sock.sendMessage(from, {text: `✅ ${ip} dibuka!`})
        }
        ros.close()
      }

      if(text === '/restart'){
        let active = await ros.menu('/ppp active').getAll()
        let target = active.find(a => a.name === clientData.pppoe_user)
        if(target){
          await ros.menu('/ppp active').remove(target['.id'])
          await sock.sendMessage(from, {text: `🔄 Modem ${clientData.pppoe_user} direstart, tunggu 30 detik...`})
        } else {
          await sock.sendMessage(from, {text: `❌ PPoE ${clientData.pppoe_user} tidak aktif`})
        }
        ros.close()
      }

      if(isJuragan && text === '/cek all'){
        let all = await ros.menu('/ppp active').getAll()
        let reply = `Total PPoE aktif: ${all.length}\n\n`
        all.slice(0,20).forEach(a => { reply += `- ${a.name} - ${a.address}\n` })
        await sock.sendMessage(from, {text: reply})
        ros.close()
      }

      if(isJuragan && text.startsWith('/addclient ')){
        // Format: /addclient 628xxx pppoe_user
        let parts = text.split(' ')
        let wa = parts[1] + '@s.whatsapp.net'
        let pppoe = parts[2]
        await supabase.from('clients').upsert({ id: wa, pppoe_user: pppoe, juragan_id: from })
        await sock.sendMessage(from, {text: `✅ Client ${pppoe} - ${wa} ditambahkan`})
      }

    } catch(e){
      console.error(e)
      await sock.sendMessage(from, {text: `❌ Error: ${e.message}`})
    }
  })
}

async function main(){
  console.log("🚀 Bot WA PPoE starting...")
  console.log("URL:", process.env.SUPABASE_URL? "OK" : "BELUM DI SET!")
  console.log("KEY:", process.env.SUPABASE_KEY? "OK" : "BELUM DI SET!")

  let { data: allJuragan, error } = await supabase.from('juragan').select('id')
  if(error){
    console.log("Error ambil juragan:", error.message)
    console.log("Pastikan udah Run: alter table juragan disable row level security;")
    return
  }
  console.log(`Menjalankan ${allJuragan?.length || 0} juragan...`)
  allJuragan?.forEach(j => startJuragan(j.id))
  if(!allJuragan?.length){
    console.log("Bot siap! Tambahin juragan di Supabase dulu co!")
    console.log("Contoh SQL: insert into juragan (id, mt_host, mt_user, mt_pass) values ('62812xxxx@s.whatsapp.net', '192.168.1.1', 'admin', 'password')")
  }
}

main()
