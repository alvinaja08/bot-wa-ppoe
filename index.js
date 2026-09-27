const { default: makeWASocket, useMultiFileAuthState } = require("@whiskeysockets/baileys")
const { RouterOSClient } = require("routeros-client")
const QRCode = require('qrcode')
const { createClient } = require('@supabase/supabase-js')
const pino = require('pino')

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY)

async function connectMikrotik(juraganId){
  let { data: j } = await supabase.from('juragan').select('*').eq('id', juraganId).single()
  if(!j) throw new Error("Juragan belum daftar")
  const client = new RouterOSClient({ host: j.mt_host, user: j.mt_user, password: j.mt_pass, keepalive: true })
  return await client.connect()
}

async function startJuragan(juraganId){
  const { state, saveCreds } = await useMultiFileAuthState(`./session/${juraganId}`)
  const sock = makeWASocket({ auth: state, logger: pino({level:'silent'}), printQRInTerminal: true })
  sock.ev.on('creds.update', saveCreds)

  sock.ev.on('connection.update', async (update) => {
    const { connection, qr } = update
    if(qr){
      console.log(`\n=== QR JURAGAN ${juraganId} ===`)
      console.log(await QRCode.toString(qr, {type:'terminal', small:true}))
    }
    if(connection === 'open') console.log(`✅ ${juraganId} CONNECTED!`)
    if(connection === 'close') setTimeout(() => startJuragan(juraganId), 3000)
  })

  sock.ev.on('messages.upsert', async ({messages}) => {
    const msg = messages[0]
    if(!msg.message || msg.key.fromMe) return
    const from = msg.key.remoteJid
    const textRaw = (msg.message.conversation || msg.message.extendedTextMessage?.text || "").trim()
    const text = textRaw.toLowerCase()

    let { data: juraganData } = await supabase.from('juragan').select('*').eq('id', from).single()
    let { data: clientData } = await supabase.from('clients').select('*').eq('id', from).single()
    let ownerId = clientData?.juragan_id || juraganData?.id

    // === BELUM DAFTAR SAMA SEKALI ===
    if(!juraganData &&!clientData){
      if(text.startsWith('/daftar ')){
        let parts = textRaw.split(' ')
        if(parts.length < 4) return sock.sendMessage(from, {text: `❌ Format salah!\n\nKetik:\n/daftar IP USER PASS\nContoh:\n/daftar 192.168.1.1 admin 1234`})
        await supabase.from('juragan').upsert({ id: from, mt_host: parts[1], mt_user: parts[2], mt_pass: parts[3] })
        return sock.sendMessage(from, {text: `✅ JOS! Mikrotik ${parts[1]} kesimpen!\n\nPerintah juragan:\n/cek all - liat PPoE aktif\n/addclient 628xxx nama_pppoe\n/cek - (buat client)`})
      }
      return sock.sendMessage(from, {text: `👋 Halo juragan!\nLu belum daftar co.\n\nKetik:\n/daftar IP_MIKROTIK USER PASS\n\nContoh:\n/daftar 103.12.1.1 admin passwordmu`})
    }

    if(!ownerId) ownerId = from

    try{
      const ros = await connectMikrotik(ownerId)

      if(text === '/cek' || text === '/cekperangkat'){
        let pppoeName = clientData?.pppoe_user || juraganData?.pppoe_clients?.[0]
        let dhcp = await ros.menu('/ip dhcp-server lease').getAll()
        let reply = `📡 Perangkat:\n`
        dhcp.slice(0,15).forEach((d,i)=> reply += `${i+1}. ${d['host-name']||'HP'} - ${d.address}\n`)
        await sock.sendMessage(from, {text: reply + `\n/blokir IP /restart`})
      }
      if(text.startsWith('/blokir ')){
        let ip = text.split(' ')[1]
        await ros.menu('/ip firewall filter').add({ chain:'forward', srcAddress: ip, action:'drop', comment:`blok ${from}` })
        await sock.sendMessage(from, {text: `✅ ${ip} diblokir`})
      }
      if(text.startsWith('/buka ')){
        let ip = text.split(' ')[1]
        let filters = await ros.menu('/ip firewall filter').getAll()
        let t = filters.find(f => f.srcAddress === ip)
        if(t) await ros.menu('/ip firewall filter').remove(t['.id'])
        await sock.sendMessage(from, {text: `✅ ${ip} dibuka`})
      }
      if(text === '/restart'){
        let active = await ros.menu('/ppp active').getAll()
        let target = active.find(a => a.name === (clientData?.pppoe_user))
        if(target){ await ros.menu('/ppp active').remove(target['.id']); await sock.sendMessage(from, {text: `🔄 Restart PPoE ${target.name}...`}) }
      }
      if(juraganData && text === '/cek all'){
        let all = await ros.menu('/ppp active').getAll()
        let reply = `Aktif: ${all.length}\n` + all.slice(0,20).map(a=>`- ${a.name} ${a.address}`).join('\n')
        await sock.sendMessage(from, {text: reply})
      }
      if(juraganData && text.startsWith('/addclient ')){
        let parts = textRaw.split(' ')
        let wa = parts[1].replace(/[^0-9]/g,'') + '@s.whatsapp.net'
        let pppoe = parts[2]
        await supabase.from('clients').upsert({ id: wa, pppoe_user: pppoe, juragan_id: from })
        await sock.sendMessage(from, {text: `✅ Client ${pppoe} (${parts[1]}) ditambah`})
      }
      ros.close()
    }catch(e){
      await sock.sendMessage(from, {text: `❌ Error: ${e.message}\nCek /daftar lu bener gak`})
    }
  })
}

async function main(){
  console.log("🚀 Bot Auto-Daftar START")
  let { data } = await supabase.from('juragan').select('id')
  data?.forEach(j => startJuragan(j.id))
  if(!data?.length) console.log("Belum ada juragan, tunggu ada yang /daftar")
  // Bot utama yang nunggu pendaftar baru (pakai 1 session default)
  startJuragan('main-bot')
}
main()
