package org.offgrid.navigation;

import android.content.ContentValues;
import android.database.Cursor;
import android.database.sqlite.SQLiteDatabase;
import android.database.sqlite.SQLiteOpenHelper;
import android.os.StatFs;
import android.util.Base64;
import com.getcapacitor.JSObject;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;
import org.json.JSONArray;
import org.json.JSONObject;
import java.security.MessageDigest;
import java.util.concurrent.ExecutorService;
import java.util.concurrent.Executors;

/** Private, durable map storage. No external storage permissions or path access. */
@CapacitorPlugin(name = "OfflineStorage")
public class OfflineStoragePlugin extends Plugin {
    private final ExecutorService io = Executors.newSingleThreadExecutor();
    private SQLiteOpenHelper helper;
    private static final int CHUNK = 128 * 1024;
    private static final long MAX_FILE = 32L * 1024 * 1024;
    private static final String PROCESS_TOKEN = java.util.UUID.randomUUID().toString();
    private static void validateManifest(JSONObject manifest) throws Exception {
        if(manifest.getJSONArray("assets").length()>5000 || manifest.getLong("totalBytes")>64L*1024*1024 || manifest.toString().getBytes(java.nio.charset.StandardCharsets.UTF_8).length>1024*1024) throw new IllegalArgumentException("Map exceeds Android release limits");
    }

    @Override public void load() {
        helper = new SQLiteOpenHelper(getContext(), "offline-maps.db", null, 1) {
            @Override public void onConfigure(SQLiteDatabase db) {
                db.execSQL("PRAGMA synchronous=FULL");
            }
            @Override public void onCreate(SQLiteDatabase db) {
                createSchema(db);
            }
            @Override public void onUpgrade(SQLiteDatabase db, int oldVersion, int newVersion) {
                throw new IllegalStateException("Unsupported map storage upgrade");
            }
            @Override public void onOpen(SQLiteDatabase db) {
                super.onOpen(db);
                db.beginTransaction();
                try {
                    JSONObject previous=record(db,"runtime","process");
                    if(previous==null || !PROCESS_TOKEN.equals(previous.optString("token"))) {
                        // Android runs this app in one process. After process
                        // death, no previous download owner can still write.
                        db.delete("leases",null,null);
                        put(db,"runtime","process",new JSONObject().put("token",PROCESS_TOKEN));
                    }
                    db.setTransactionSuccessful();
                } catch(Exception error) { throw new IllegalStateException("Cannot initialize map storage",error); }
                finally { db.endTransaction(); }
            }
        };
        helper.setWriteAheadLoggingEnabled(true);
    }
    static void createSchema(SQLiteDatabase db) {
                db.execSQL("CREATE TABLE records(kind TEXT,id TEXT,value TEXT NOT NULL,PRIMARY KEY(kind,id))");
                db.execSQL("CREATE TABLE files(kind TEXT,dataset TEXT,path TEXT,bytes INTEGER NOT NULL,digest TEXT,PRIMARY KEY(kind,dataset,path))");
                db.execSQL("CREATE TABLE chunks(kind TEXT,dataset TEXT,path TEXT,offset INTEGER,data BLOB NOT NULL,PRIMARY KEY(kind,dataset,path,offset))");
                db.execSQL("CREATE TABLE leases(region TEXT PRIMARY KEY,owner TEXT,expires INTEGER)");
    }
    @Override protected void handleOnDestroy() {
        io.execute(() -> helper.close()); io.shutdown();
    }
    @PluginMethod public void run(PluginCall call) {
        io.execute(() -> {
            try { call.resolve(execute(helper.getWritableDatabase(), call)); }
            catch (Exception e) {
                // Do not log locations, user data, or bridge payloads.
                call.reject("Map storage operation failed. Free space or check the saved map files.", e);
            }
        });
    }
    private static String require(PluginCall call, String key) {
        String value = call.getString(key);
        if (value == null || value.isEmpty() || value.length() > 256) throw new IllegalArgumentException("Missing " + key);
        return value;
    }
    private static Long integer(PluginCall call, String key, boolean optional) {
        Object value=call.getData().opt(key);
        if(optional && (value==null || value==JSONObject.NULL)) return null;
        // Capacitor's getLong accepts Long only. JSON encodes small values as
        // Integer, so offsets such as zero otherwise become the fallback -1.
        if(!(value instanceof Number)) throw new IllegalArgumentException("Invalid integer " + key);
        double number=((Number)value).doubleValue();
        if(!Double.isFinite(number) || number!=Math.rint(number) || Math.abs(number)>9007199254740991d) throw new IllegalArgumentException("Invalid integer " + key);
        return ((Number)value).longValue();
    }
    private static String dataset(String value) {
        if (!value.matches("[a-f0-9]{64}")) throw new IllegalArgumentException("Invalid dataset");
        return value;
    }
    private static String path(String value) {
        if (!value.equals("map.json") && !value.matches("tiles/[0123456789bcdefghjkmnpqrstuvwxyz]{6}\\.bin")) throw new IllegalArgumentException("Invalid map path");
        return value;
    }
    private static String kind(String value) {
        if (!value.equals("asset") && !value.equals("partial") && !value.equals("pending")) throw new IllegalArgumentException("Invalid file kind");
        return value;
    }
    private static JSONObject record(SQLiteDatabase db, String kind, String id) throws Exception {
        try (Cursor c = db.rawQuery("SELECT value FROM records WHERE kind=? AND id=?", new String[]{kind,id})) {
            return c.moveToFirst() ? new JSONObject(c.getString(0)) : null;
        }
    }
    private static JSONArray records(SQLiteDatabase db, String kind) throws Exception {
        JSONArray result = new JSONArray();
        try (Cursor c = db.rawQuery("SELECT value FROM records WHERE kind=? ORDER BY id", new String[]{kind})) {
            while (c.moveToNext()) result.put(new JSONObject(c.getString(0)));
        }
        return result;
    }
    private static void put(SQLiteDatabase db, String kind, String id, JSONObject value) {
        ContentValues v = new ContentValues(); v.put("kind",kind); v.put("id",id); v.put("value",value.toString());
        db.insertWithOnConflict("records",null,v,SQLiteDatabase.CONFLICT_REPLACE);
    }
    private static void clear(SQLiteDatabase db, String kind, String dataset, String path) {
        String[] args = {kind,dataset,path};
        db.delete("files","kind=? AND dataset=? AND path=?",args);
        db.delete("chunks","kind=? AND dataset=? AND path=?",args);
    }
    private static JSObject info(SQLiteDatabase db, String kind, String dataset, String path) {
        JSObject result = new JSObject();
        try (Cursor c = db.rawQuery("SELECT bytes,digest FROM files WHERE kind=? AND dataset=? AND path=?",new String[]{kind,dataset,path})) {
            boolean exists = c.moveToFirst(); result.put("exists",exists);
            if (exists) { result.put("bytes",c.getLong(0)); result.put("sha256",c.getString(1)); }
        }
        return result;
    }
    private static void prune(SQLiteDatabase db, String dataset) throws Exception {
        JSONArray installed = records(db,"installed");
        for (int i=0;i<installed.length();i++) if (installed.getJSONObject(i).getString("datasetId").equals(dataset)) return;
        db.delete("chunks","dataset=?",new String[]{dataset});
        db.delete("files","dataset=?",new String[]{dataset});
        db.delete("records","kind='generation' AND id=?",new String[]{dataset});
    }
    JSObject execute(SQLiteDatabase db, PluginCall call) throws Exception {
        String op = require(call,"op");
        JSObject result = new JSObject();
        // Every operation is serialized on a dedicated worker. Transactions are
        // also required for process death and independent database connections.
        db.beginTransaction();
        try {
            if (op.equals("space")) {
                result.put("bytes",new StatFs(getContext().getFilesDir().getPath()).getAvailableBytes());
            } else if (op.equals("snapshot")) {
                result.put("installed",records(db,"installed")); result.put("downloads",records(db,"download"));
            } else if (op.equals("batch")) {
                String id=dataset(require(call,"datasetId")); JSONArray paths=call.getArray("paths"), files=new JSONArray(); int total=0;
                if(paths==null || paths.length()>128) throw new IllegalArgumentException("Invalid map read batch");
                for(int i=0;i<paths.length();i++) {
                    String p=path(paths.getString(i)); JSObject f=info(db,"asset",id,p); f.put("path",p);
                    if(f.optBoolean("exists",false) && f.optLong("bytes",MAX_FILE+1)<=CHUNK) {
                        long bytes=f.getLong("bytes");
                        if(total+bytes>CHUNK && files.length()>0) break;
                        try(Cursor c=db.rawQuery("SELECT data FROM chunks WHERE kind='asset' AND dataset=? AND path=? AND offset=0",new String[]{id,p})) {
                            if(!c.moveToFirst()) throw new IllegalStateException("Missing map chunk");
                            byte[] data=c.getBlob(0);
                            if(data.length!=bytes) throw new IllegalStateException("Incomplete map chunk");
                            f.put("data",Base64.encodeToString(data,Base64.NO_WRAP)); total+=data.length;
                        }
                    }
                    files.put(f);
                }
                result.put("files",files);
            } else if (op.equals("record")) {
                JSONObject value = call.getObject("record");
                put(db,"download",value.getString("regionId"),value);
            } else if (op.equals("register")) {
                JSONObject m = call.getObject("manifest"); String id = dataset(m.getString("datasetId"));
                validateManifest(m);
                put(db,"generation",id,new JSONObject().put("regionId",m.getString("regionId")));
            } else if (op.equals("commit")) {
                JSONObject m = call.getObject("manifest"); String id = dataset(m.getString("datasetId"));
                validateManifest(m);
                JSONArray assets = m.getJSONArray("assets"); long total = 0;
                if (assets.length()<2 || assets.length()>20000) throw new IllegalArgumentException("Invalid asset count");
                for (int i=0;i<assets.length();i++) {
                    JSONObject a=assets.getJSONObject(i); JSObject f=info(db,"asset",id,path(a.getString("path")));
                    if (!f.optBoolean("exists",false) || f.optLong("bytes",-1L)!=a.getLong("bytes") || !a.getString("sha256").equals(f.getString("sha256"))) throw new IllegalStateException("Unverified asset");
                    total += a.getLong("bytes");
                }
                if (total!=m.getLong("totalBytes") || total>1024L*1024*1024) throw new IllegalArgumentException("Invalid map size");
                String region=m.getString("regionId"); long now=System.currentTimeMillis();
                put(db,"installed",region,new JSONObject().put("regionId",region).put("datasetId",id).put("manifest",m).put("installedAt",now));
                put(db,"download",region,new JSONObject().put("regionId",region).put("datasetId",id).put("phase","ready").put("downloadedBytes",total).put("totalBytes",total).put("updatedAt",now));
            } else if (op.equals("forget")) {
                String region=require(call,"regionId"); JSONObject old=record(db,"installed",region);
                Long installedAt=integer(call,"installedAt",true);
                if (old!=null && old.getString("datasetId").equals(require(call,"datasetId")) && (installedAt==null || old.getLong("installedAt")==installedAt)) db.delete("records","kind='installed' AND id=?",new String[]{region});
            } else if (op.equals("prune")) {
                prune(db,dataset(require(call,"datasetId")));
            } else if (op.equals("remove")) {
                String region=require(call,"regionId");
                db.delete("records","kind IN ('installed','download') AND id=?",new String[]{region});
                try (Cursor c=db.rawQuery("SELECT id,value FROM records WHERE kind='generation'",null)) {
                    while(c.moveToNext()) if(new JSONObject(c.getString(1)).getString("regionId").equals(region)) prune(db,c.getString(0));
                }
            } else if (op.equals("acquire") || op.equals("release")) {
                String region=require(call,"regionId"),owner=require(call,"owner"); long now=System.currentTimeMillis();
                if(op.equals("release")) db.delete("leases","region=? AND owner=?",new String[]{region,owner});
                else {
                    boolean acquired=true;
                    try(Cursor c=db.rawQuery("SELECT owner,expires FROM leases WHERE region=?",new String[]{region})) {
                        if(c.moveToFirst() && !owner.equals(c.getString(0)) && c.getLong(1)>now) acquired=false;
                    }
                    if(acquired) {
                        ContentValues v=new ContentValues();v.put("region",region);v.put("owner",owner);v.put("expires",now+45000);
                        db.insertWithOnConflict("leases",null,v,SQLiteDatabase.CONFLICT_REPLACE);
                    }
                    result.put("acquired",acquired);
                }
            } else {
                String id=dataset(require(call,"datasetId")),p=path(require(call,"path"));
                String k=op.equals("finalize") ? "pending" : kind(require(call,"kind"));
                JSObject f=info(db,k,id,p);
                if(op.equals("info")) result=f;
                else if(op.equals("clear")) clear(db,k,id,p);
                else if(op.equals("read")) {
                    long offset=integer(call,"offset",false);
                    if(offset<0 || offset%CHUNK!=0) throw new IllegalArgumentException("Invalid read offset");
                    try(Cursor c=db.rawQuery("SELECT data FROM chunks WHERE kind=? AND dataset=? AND path=? AND offset=?",new String[]{k,id,p,Long.toString(offset)})) {
                        if(!c.moveToFirst()) throw new IllegalStateException("Missing map chunk");
                        result.put("data",Base64.encodeToString(c.getBlob(0),Base64.NO_WRAP));
                    }
                } else if(op.equals("write")) {
                    long offset=integer(call,"offset",false),size=f.optLong("bytes",0L);
                    byte[] data=Base64.decode(requirePayload(call),Base64.NO_WRAP);
                    if(offset!=size || offset%CHUNK!=0 || data.length==0 || data.length>CHUNK || offset+data.length>MAX_FILE) throw new IllegalArgumentException("Invalid map append");
                    ContentValues v=new ContentValues();v.put("kind",k);v.put("dataset",id);v.put("path",p);v.put("offset",offset);v.put("data",data);
                    db.insertOrThrow("chunks",null,v);
                    v=new ContentValues();v.put("kind",k);v.put("dataset",id);v.put("path",p);v.put("bytes",offset+data.length);
                    db.insertWithOnConflict("files",null,v,SQLiteDatabase.CONFLICT_REPLACE);
                } else if(op.equals("finalize")) {
                    long bytes=integer(call,"bytes",false); String expected=require(call,"digest");
                    if(bytes<=0 || bytes!=f.optLong("bytes",-1L) || !expected.matches("[a-f0-9]{64}")) throw new IllegalStateException("Invalid file size");
                    MessageDigest sha=MessageDigest.getInstance("SHA-256"); long count=0;
                    try(Cursor c=db.rawQuery("SELECT offset,data FROM chunks WHERE kind='pending' AND dataset=? AND path=? ORDER BY offset",new String[]{id,p})) {
                        while(c.moveToNext()) { if(c.getLong(0)!=count) throw new IllegalStateException("Chunk gap"); byte[] b=c.getBlob(1);sha.update(b);count+=b.length; }
                    }
                    StringBuilder digest=new StringBuilder();for(byte b:sha.digest()) digest.append(String.format(java.util.Locale.ROOT,"%02x",b&255));
                    if(count!=bytes || !expected.contentEquals(digest)) throw new IllegalStateException("Map checksum failed");
                    clear(db,"asset",id,p);
                    ContentValues v=new ContentValues();v.put("kind","asset");v.put("digest",expected);
                    db.update("files",v,"kind='pending' AND dataset=? AND path=?",new String[]{id,p});
                    v=new ContentValues();v.put("kind","asset");db.update("chunks",v,"kind='pending' AND dataset=? AND path=?",new String[]{id,p});
                    clear(db,"partial",id,p);
                } else throw new IllegalArgumentException("Unknown storage operation");
            }
            db.setTransactionSuccessful();
            return result;
        } finally { db.endTransaction(); }
    }
    private static String requirePayload(PluginCall call) {
        String data=call.getString("data");
        if(data==null || data.length()>4*((CHUNK+2)/3)) throw new IllegalArgumentException("Invalid chunk");
        return data;
    }
}
