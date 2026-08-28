use <pathbuilder.scad>

$fn = 32;

w = 600;
l = 600;
h = 800;
r = 50;
cr = 20;
ww = w - r - r;
ll = l - r - r;
hh = h - r - r;

module case(){
    difference(){
        translate([0,0,r]) minkowski()
        {
            linear_extrude(hh) M(-ww*0.5+100, -ll*0.5+100)
            H(ww*0.5-100)
            l(100,100)
            V(ll*0.5)
            fillet(cr)
            H(-ww*0.5)
            fillet(cr)
            V(-ll*0.5+200);
            sphere(r);
        }
        translate([-w*0.5+r+cr,270,r]) cube([ww-cr-cr, 30, hh]);
        
    }
    translate([-w*0.5+r+cr-1,289,r]) cube([ww-cr-cr-2, 10, hh-2]);
}

module handle(cutout=false){
    h = 40+1;
    if (cutout){
        translate([0,0,-1]) hull(){
            translate([-50, 0, 0]) cylinder(d=40, h=1);
            translate([-50, 40, h]) cylinder(d=40, h=1);
            translate([50, 0, 0]) cylinder(d=40, h=1);
            translate([50, 40, h]) cylinder(d=40, h=1);
        }
    } else {
        difference(){
            hull(){
                translate([-50, 0, -3]) cylinder(d=80, h=3);
                translate([50, 0, -3]) cylinder(d=80, h=3);     
            }
            hull(){
                translate([-50, 0, -4]) cylinder(d=40, h=3+2);
                translate([50, 0, -4]) cylinder(d=40, h=3+2);     
            }            
        }
    }
}

module sub_speaker(){
    difference(){
        case();
        translate([w*0.5,80,h-200]) rotate([90,0,-90]) handle(cutout=true);
        translate([-w*0.5,80,h-200]) rotate([90,0,90]) handle(cutout=true);  
    }
    translate([w*0.5,80,h-200]) rotate([90,0,-90]) handle(cutout=false);
    translate([-w*0.5,80,h-200]) rotate([90,0,90]) handle(cutout=false);     
}


sub_speaker();