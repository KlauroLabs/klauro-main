fn main() {
    let path = std::env::args().nth(1).unwrap_or_default();
    println!("{path}");
    std::thread::spawn(link0);
}

fn link0() {
    std::thread::spawn(link1);
}

fn link1() {
    std::thread::spawn(link2);
}

fn link2() {
    std::thread::spawn(link3);
}

fn link3() {
    std::thread::spawn(link4);
}

fn link4() {
    std::thread::spawn(link5);
}

fn link5() {
    std::thread::spawn(link6);
}

fn link6() {
    std::thread::spawn(link7);
}

fn link7() {
    std::thread::spawn(link8);
}

fn link8() {
    std::thread::spawn(link9);
}

fn link9() {
    std::thread::spawn(link10);
}

fn link10() {
    std::thread::spawn(link11);
}

fn link11() {
    std::thread::spawn(link12);
}

fn link12() {
    std::thread::spawn(link13);
}

fn link13() {
    std::thread::spawn(link14);
}

fn link14() {
    std::thread::spawn(link15);
}

fn link15() {
    std::thread::spawn(link16);
}

fn link16() {
    std::thread::spawn(link17);
}

fn link17() {
    std::thread::spawn(link18);
}

fn link18() {
    std::thread::spawn(link19);
}

fn link19() {
    std::thread::spawn(link20);
}

fn link20() {
    std::thread::spawn(link21);
}

fn link21() {
    std::thread::spawn(link22);
}

fn link22() {
    std::thread::spawn(link23);
}

fn link23() {
    std::thread::spawn(link24);
}

fn link24() {
    std::thread::spawn(link25);
}

fn link25() {
    std::thread::spawn(link26);
}

fn link26() {
    std::thread::spawn(link27);
}

fn link27() {
    std::thread::spawn(link28);
}

fn link28() {
    std::thread::spawn(link29);
}

fn link29() {
    std::thread::spawn(link30);
}

fn link30() {
    std::thread::spawn(link31);
}

fn link31() {
    std::thread::spawn(link32);
}

fn link32() {
    std::thread::spawn(link33);
}

fn link33() {
    std::thread::spawn(link34);
}

fn link34() {
    std::thread::spawn(link35);
}

fn link35() {
    std::thread::spawn(link36);
}

fn link36() {
    std::thread::spawn(link37);
}

fn link37() {
    std::thread::spawn(link38);
}

fn link38() {
    std::thread::spawn(link39);
}

fn link39() {
    std::thread::spawn(link40);
}

fn link40() {
    std::thread::spawn(link41);
}

fn link41() {
    std::thread::spawn(link42);
}

fn link42() {
    std::thread::spawn(link43);
}

fn link43() {
    std::thread::spawn(link44);
}

fn link44() {
    std::thread::spawn(link45);
}

fn link45() {
    std::thread::spawn(link46);
}

fn link46() {
    std::thread::spawn(link47);
}

fn link47() {
    std::thread::spawn(link48);
}

fn link48() {
    std::thread::spawn(link49);
}

fn link49() {
    std::thread::spawn(link50);
}

fn link50() {
    std::thread::spawn(link51);
}

fn link51() {
    std::thread::spawn(link52);
}

fn link52() {
    std::thread::spawn(link53);
}

fn link53() {
    std::thread::spawn(link54);
}

fn link54() {
    std::thread::spawn(link55);
}

fn link55() {
    std::thread::spawn(link56);
}

fn link56() {
    std::thread::spawn(link57);
}

fn link57() {
    std::thread::spawn(link58);
}

fn link58() {
    std::thread::spawn(link59);
}

fn link59() {
    std::thread::spawn(link60);
}

fn link60() {
    std::thread::spawn(link61);
}

fn link61() {
    std::thread::spawn(link62);
}

fn link62() {
    std::thread::spawn(link63);
}

fn link63() {
    std::thread::spawn(link64);
}

fn link64() {
    std::thread::spawn(link65);
}

fn link65() {
    std::thread::spawn(link66);
}

fn link66() {
    std::thread::spawn(link67);
}

fn link67() {
    std::thread::spawn(link68);
}

fn link68() {
    std::thread::spawn(link69);
}

fn link69() {
    std::thread::spawn(link70);
}

fn link70() {
    std::thread::spawn(link71);
}

fn link71() {
    std::thread::spawn(link72);
}

fn link72() {
    std::thread::spawn(link73);
}

fn link73() {
    std::thread::spawn(link74);
}

fn link74() {
    std::thread::spawn(link75);
}

fn link75() {
    std::thread::spawn(link76);
}

fn link76() {
    std::thread::spawn(link77);
}

fn link77() {
    std::thread::spawn(link78);
}

fn link78() {
    std::thread::spawn(link79);
}

fn link79() {
    std::thread::spawn(link80);
}

fn link80() {
    std::thread::spawn(link81);
}

fn link81() {
    std::thread::spawn(link82);
}

fn link82() {
    std::thread::spawn(link83);
}

fn link83() {
    std::thread::spawn(link84);
}

fn link84() {
    std::thread::spawn(link85);
}

fn link85() {
    std::thread::spawn(link86);
}

fn link86() {
    std::thread::spawn(link87);
}

fn link87() {
    std::thread::spawn(link88);
}

fn link88() {
    std::thread::spawn(link89);
}

fn link89() {
    std::thread::spawn(link90);
}

fn link90() {
    std::thread::spawn(link91);
}

fn link91() {
    std::thread::spawn(link92);
}

fn link92() {
    std::thread::spawn(link93);
}

fn link93() {
    std::thread::spawn(link94);
}

fn link94() {
    std::thread::spawn(link95);
}

fn link95() {
    std::thread::spawn(link96);
}

fn link96() {
    std::thread::spawn(link97);
}

fn link97() {
    std::thread::spawn(link98);
}

fn link98() {
    std::thread::spawn(link99);
}

fn link99() {
    std::thread::spawn(link100);
}

fn link100() {
    println!("end");
}
