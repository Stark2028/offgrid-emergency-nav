package org.offgrid.navigation;

import android.database.sqlite.SQLiteDatabase;
import android.util.Base64;
import androidx.test.ext.junit.runners.AndroidJUnit4;
import com.getcapacitor.JSObject;
import com.getcapacitor.PluginCall;
import org.json.JSONArray;
import org.json.JSONObject;
import org.junit.After;
import org.junit.Before;
import org.junit.Test;
import org.junit.runner.RunWith;
import java.security.MessageDigest;
import static org.junit.Assert.*;

/** Runs against Android SQLite, including rollback and the native SHA implementation. */
@RunWith(AndroidJUnit4.class)
public class OfflineStorageTest {
    private SQLiteDatabase db;
    private OfflineStoragePlugin plugin;
    private static String hexId(char value) {
        char[] chars=new char[64];java.util.Arrays.fill(chars,value);return new String(chars);
    }
    private final String id=hexId('a'), replacement=hexId('b');
    @Before public void setup() { db=SQLiteDatabase.create(null); OfflineStoragePlugin.createSchema(db); plugin=new OfflineStoragePlugin(); }
    @After public void teardown() { db.close(); }
    private JSObject run(String op, Object... args) throws Exception {
        JSObject data=new JSObject();data.put("op",op);
        for(int i=0;i<args.length;i+=2)data.put((String)args[i],args[i+1]);
        return plugin.execute(db,new PluginCall(null,"OfflineStorage","test","run",data));
    }
    private String digest(byte[] bytes) throws Exception {
        StringBuilder text=new StringBuilder();for(byte b:MessageDigest.getInstance("SHA-256").digest(bytes))text.append(String.format(java.util.Locale.ROOT,"%02x",b&255));return text.toString();
    }
    private JSONObject stage(String dataset,String path,byte[] bytes) throws Exception {
        run("write","kind","pending","datasetId",dataset,"path",path,"offset",0,"data",Base64.encodeToString(bytes,Base64.NO_WRAP));
        String hash=digest(bytes);
        run("finalize","datasetId",dataset,"path",path,"bytes",bytes.length,"digest",hash);
        return new JSONObject().put("path",path).put("bytes",bytes.length).put("sha256",hash);
    }
    private JSONObject manifest(String dataset,boolean complete) throws Exception {
        JSONArray assets=new JSONArray();
        assets.put(stage(dataset,"map.json",new byte[]{1,2,3}));
        if(complete)assets.put(stage(dataset,"tiles/ttnfsw.bin",new byte[]{4,5}));
        else assets.put(new JSONObject().put("path","tiles/ttnfsw.bin").put("bytes",2).put("sha256",hexId('f')));
        JSONObject m=new JSONObject().put("regionId","test-area").put("datasetId",dataset).put("totalBytes",5).put("assets",assets);
        run("register","manifest",m); return m;
    }
    @Test public void interruptedUpdateKeepsActiveGenerationAndThenSwitchesAtomically() throws Exception {
        run("commit","manifest",manifest(id,true));
        JSONObject next=manifest(replacement,false);
        try { run("commit","manifest",next); fail("Incomplete update activated"); } catch(IllegalStateException expected) { }
        assertEquals(id,run("snapshot").getJSONArray("installed").getJSONObject(0).getString("datasetId"));
        next.getJSONArray("assets").put(1,stage(replacement,"tiles/ttnfsw.bin",new byte[]{4,5}));
        run("commit","manifest",next);
        assertEquals(replacement,run("snapshot").getJSONArray("installed").getJSONObject(0).getString("datasetId"));
        run("forget","regionId","test-area","datasetId",id);
        assertEquals(1,run("snapshot").getJSONArray("installed").length());
    }
    @Test public void nativeChecksumRejectsDamagedPayloadAndPreservesPrefix() throws Exception {
        run("write","kind","pending","datasetId",id,"path","map.json","offset",0,"data","AQID");
        try { run("finalize","datasetId",id,"path","map.json","bytes",3,"digest",hexId('f')); fail("Bad checksum accepted"); } catch(IllegalStateException expected) { }
        assertFalse(run("info","kind","asset","datasetId",id,"path","map.json").getBoolean("exists"));
        assertEquals(3,run("info","kind","pending","datasetId",id,"path","map.json").getLong("bytes"));
        run("write","kind","partial","datasetId",id,"path","map.json","offset",0d,"data","AQID");
        assertEquals("AQID",run("read","kind","partial","datasetId",id,"path","map.json","offset",0).getString("data"));
        try { run("write","kind","partial","datasetId",id,"path","map.json","offset",3,"data","BA=="); fail("Unaligned append accepted"); } catch(IllegalArgumentException expected) { }
        assertEquals(3,run("info","kind","partial","datasetId",id,"path","map.json").getLong("bytes"));
    }
    @Test public void leaseIsExclusiveAndActiveFilesCannotBePruned() throws Exception {
        assertTrue(run("acquire","regionId","test-area","owner","first").getBoolean("acquired"));
        assertFalse(run("acquire","regionId","test-area","owner","second").getBoolean("acquired"));
        run("release","regionId","test-area","owner","second");
        assertFalse(run("acquire","regionId","test-area","owner","second").getBoolean("acquired"));
        run("release","regionId","test-area","owner","first");
        assertTrue(run("acquire","regionId","test-area","owner","second").getBoolean("acquired"));
        run("commit","manifest",manifest(id,true));run("prune","datasetId",id);
        assertTrue(run("info","kind","asset","datasetId",id,"path","map.json").getBoolean("exists"));
        manifest(replacement,true);run("remove","regionId","test-area");
        assertEquals(0,run("snapshot").getJSONArray("installed").length());
        assertFalse(run("info","kind","asset","datasetId",replacement,"path","map.json").getBoolean("exists"));
    }
    @Test public void invalidIdentifiersCannotReachStorage() throws Exception {
        for(String path:new String[]{"../secret","tiles/../../file","map.json/other"}) {
            try { run("clear","kind","partial","datasetId",id,"path",path);fail("Invalid path accepted"); } catch(IllegalArgumentException expected) { }
        }
        try { run("clear","kind","partial","datasetId","../secret","path","map.json");fail("Invalid dataset accepted"); } catch(IllegalArgumentException expected) { }
        for(Object offset:new Object[]{0.5,"0",JSONObject.NULL}) {
            try { run("write","kind","partial","datasetId",id,"path","map.json","offset",offset,"data","AQID");fail("Invalid offset accepted"); } catch(IllegalArgumentException expected) { }
        }
    }
    @Test public void batchedReadsPreserveOrderAndBoundLargeBridgeMessages() throws Exception {
        stage(id,"tiles/ttnfsw.bin",new byte[]{1,2,3});
        byte[] large=new byte[128*1024+4];java.util.Arrays.fill(large,(byte)7);
        run("write","kind","pending","datasetId",id,"path","map.json","offset",0,"data",Base64.encodeToString(java.util.Arrays.copyOfRange(large,0,128*1024),Base64.NO_WRAP));
        run("write","kind","pending","datasetId",id,"path","map.json","offset",128*1024,"data",Base64.encodeToString(java.util.Arrays.copyOfRange(large,128*1024,large.length),Base64.NO_WRAP));
        run("finalize","datasetId",id,"path","map.json","bytes",large.length,"digest",digest(large));
        JSONArray files=run("batch","datasetId",id,"paths",new JSONArray().put("map.json").put("tiles/ttnfsw.bin").put("tiles/ttnfsy.bin")).getJSONArray("files");
        assertEquals(3,files.length());
        assertEquals("map.json",files.getJSONObject(0).getString("path"));
        assertFalse(files.getJSONObject(0).has("data"));
        assertEquals("AQID",files.getJSONObject(1).getString("data"));
        assertFalse(files.getJSONObject(2).getBoolean("exists"));
        assertEquals(4,Base64.decode(run("read","kind","asset","datasetId",id,"path","map.json","offset",128*1024).getString("data"),Base64.NO_WRAP).length);
    }
}
